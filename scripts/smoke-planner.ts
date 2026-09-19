import {
  INSTALL_DOMAIN_ALLOWLIST,
  SMOKE_REPO_URL,
  applyNetworkLockdown,
  checkEgress,
  createDaytonaClient,
  createRunSandbox,
  createScoutSandbox,
  deleteSandbox,
  executePlan,
  scoutRepo,
  servePlan,
} from "../lib/daytona.js";
import { assertDeployable, decidePlan } from "../lib/planner.js";

async function main(): Promise<void> {
  const daytona = createDaytonaClient();
  const scout = await createScoutSandbox(daytona);
  const run = await createRunSandbox(daytona, {
    domainAllowList: INSTALL_DOMAIN_ALLOWLIST,
  });

  try {
    console.log(`Scout: ${scout.id}`);
    console.log(`Run:   ${run.id}`);

    const inspection = await scoutRepo(scout, SMOKE_REPO_URL);
    console.log(`Pinned SHA: ${inspection.commitSha}`);
    console.log(`Manifests: ${Object.keys(inspection.manifests.files).join(", ") || "(none)"}`);

    const plan = await decidePlan(inspection.manifests);
    console.log(`Plan: ${plan.runtime} / ${plan.package_manager} confidence=${plan.confidence}`);
    console.log(`install: ${plan.install}`);
    console.log(`build:   ${plan.build}`);
    console.log(`start:   ${plan.start}`);
    assertDeployable(plan);

    const built = await executePlan(run, SMOKE_REPO_URL, inspection.commitSha, plan);
    console.log(`Used plan runtime=${built.usedPlan.runtime} port=${built.usedPlan.port}`);

    const lockdown = await applyNetworkLockdown(run);
    console.log(`Lockdown: ${lockdown.state} (${lockdown.detail})`);

    const egress = await checkEgress(run);
    console.log(`Egress ${egress.target}: ${egress.result} (${egress.detail})`);

    const served = await servePlan(run, built.repoPath, built.usedPlan);
    console.log(`Preview HTTP via ${served.previewUrl}`);
    console.log("Stage 4 smoke test passed.");
  } finally {
    await Promise.all([deleteSandbox(scout), deleteSandbox(run)]);
    console.log("Sandboxes deleted.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
