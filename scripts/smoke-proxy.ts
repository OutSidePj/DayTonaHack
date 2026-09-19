import {
  SMOKE_REPO_URL,
  buildAndServe,
  createDaytonaClient,
  createRunSandbox,
  createScoutSandbox,
  deleteSandbox,
  scoutCommitSha,
} from "../lib/daytona.js";
import { slugFromHost } from "../proxy/src/host.js";
import { seedLocalRoute } from "../proxy/src/lookup.js";
import { startProxy } from "../proxy/src/index.js";

const PROXY_PORT = 18080;
const SLUG = "smoke-vite";

async function fetchViaProxy(path = "/"): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://${SLUG}.localhost:${PROXY_PORT}${path}`, {
    redirect: "follow",
  });
  return { status: response.status, body: await response.text() };
}

async function main(): Promise<void> {
  if (slugFromHost(`${SLUG}.localhost:8080`) !== SLUG) {
    throw new Error("slug.localhost parsing failed");
  }

  const daytona = createDaytonaClient();
  const scout = await createScoutSandbox(daytona);
  const run = await createRunSandbox(daytona);
  const server = await startProxy(PROXY_PORT);

  try {
    console.log("Building smoke app in a run sandbox…");
    const scouted = await scoutCommitSha(scout, SMOKE_REPO_URL);
    const served = await buildAndServe(run, SMOKE_REPO_URL, scouted.commitSha);

    seedLocalRoute({
      id: "smoke-local",
      slug: SLUG,
      sandboxId: served.sandboxId,
      port: served.port,
      previewUrl: served.previewUrl,
      previewToken: served.previewToken,
      status: "live",
    });

    const live = await fetchViaProxy();
    if (live.status !== 200) {
      throw new Error(`Expected HTTP 200 via slug.localhost, got ${live.status}\n${live.body}`);
    }
    console.log(`slug.localhost HTTP ${live.status}`);

    console.log("Stopping sandbox to exercise the waking page…");
    await run.stop();
    const waking = await fetchViaProxy();
    if (waking.status !== 503 || !waking.body.includes("Waking sandbox")) {
      throw new Error(`Expected waking page, got ${waking.status}\n${waking.body}`);
    }
    console.log(`Waking page HTTP ${waking.status}`);

    let resumed: { status: number; body: string } | undefined;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      resumed = await fetchViaProxy();
      if (resumed.status === 200) break;
    }
    if (resumed?.status !== 200) {
      throw new Error(
        `Sandbox did not come back through the proxy: HTTP ${resumed?.status}\n${resumed?.body}`,
      );
    }
    console.log(`After wake HTTP ${resumed.status}`);
    console.log("Stage 2 smoke test passed.");
  } finally {
    server.close();
    await Promise.all([deleteSandbox(scout), deleteSandbox(run)]);
    console.log("Sandboxes deleted.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
