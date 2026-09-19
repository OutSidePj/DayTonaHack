import {
  SMOKE_REPO_URL,
  buildAndServe,
  createDaytonaClient,
  createRunSandbox,
  createScoutSandbox,
  deleteSandbox,
  fetchPreview,
  scoutCommitSha,
} from "../lib/daytona.js";

async function main(): Promise<void> {
  const daytona = createDaytonaClient();
  const scout = await createScoutSandbox(daytona);
  const run = await createRunSandbox(daytona);

  try {
    console.log(`Scout sandbox: ${scout.id} (${scout.snapshot ?? "unknown snapshot"})`);
    console.log(`Run sandbox:   ${run.id} (${run.snapshot ?? "unknown snapshot"})`);
    console.log(`Repo: ${SMOKE_REPO_URL}`);

    console.log("Scouting (shallow clone, no repo code)…");
    const scouted = await scoutCommitSha(scout, SMOKE_REPO_URL);
    console.log(`Pinned SHA: ${scouted.commitSha}`);

    console.log("Building and serving on the run sandbox…");
    const served = await buildAndServe(run, SMOKE_REPO_URL, scouted.commitSha);
    console.log(`Preview URL: ${served.previewUrl}`);

    const check = await fetchPreview(served.previewUrl, served.previewToken);
    if (!check.ok) {
      throw new Error(`Preview curl failed: HTTP ${check.status}`);
    }

    console.log(`Preview HTTP ${check.status}`);
    console.log("Stage 1 smoke test passed.");
  } finally {
    await Promise.all([deleteSandbox(scout), deleteSandbox(run)]);
    console.log("Sandboxes deleted.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
