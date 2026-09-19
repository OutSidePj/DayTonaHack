import {
  SMOKE_REPO_URL,
  buildAndServe,
  createDaytonaClient,
  createRunSandbox,
  createScoutSandbox,
  deleteSandbox,
  scoutCommitSha,
} from "../lib/daytona.js";
import { seedLocalRoute } from "../proxy/src/lookup.js";

const SLUG = "demo-vite";

async function main(): Promise<void> {
  const daytona = createDaytonaClient();
  const scout = await createScoutSandbox(daytona);
  const run = await createRunSandbox(daytona);

  const cleanup = async () => {
    await Promise.all([deleteSandbox(scout), deleteSandbox(run)]);
    process.exit(0);
  };
  process.on("SIGINT", () => void cleanup());
  process.on("SIGTERM", () => void cleanup());

  try {
    console.log("Building demo app in a Daytona sandbox…");
    const scouted = await scoutCommitSha(scout, SMOKE_REPO_URL);
    const served = await buildAndServe(run, SMOKE_REPO_URL, scouted.commitSha);

    seedLocalRoute({
      id: "demo-local",
      slug: SLUG,
      sandboxId: served.sandboxId,
      port: served.port,
      previewUrl: served.previewUrl,
      previewToken: served.previewToken,
      status: "live",
    });

    const url = `http://${SLUG}.localhost:8080`;
    console.log(`Registered ${url}`);
    console.log("Restart pnpm dev:proxy if it is already running, then open that URL.");
    console.log("Ctrl+C deletes the demo sandboxes.");
  } catch (error) {
    await Promise.all([deleteSandbox(scout), deleteSandbox(run)]);
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
