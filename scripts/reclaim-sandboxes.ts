import { listHoistSandboxes, reclaimHoistSandboxes } from "../lib/daytona.js";
import { listRecords } from "../lib/store.js";
import { teardownDeploy } from "../lib/orchestrator.js";

async function main(): Promise<void> {
  const keepLatest = process.argv.includes("--keep-latest");
  const rows = await listRecords();
  const lives = rows
    .filter((row) => row.status === "live" && row.sandbox_id)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

  console.log("Hoist sandboxes:");
  for (const box of await listHoistSandboxes()) {
    console.log(`  ${box.id} ${box.name ?? ""} ${box.state ?? ""} ${box.memory ?? "?"}GiB`);
  }

  if (keepLatest && lives.length > 0) {
    const keep = lives[0];
    for (const row of lives.slice(1)) {
      console.log(`Tearing down older live ${row.slug} (${row.id})`);
      await teardownDeploy(row.id);
    }
    const deleted = await reclaimHoistSandboxes(
      [keep.sandbox_id, keep.scout_sandbox_id].filter((id): id is string => Boolean(id)),
    );
    console.log(`Reclaimed ${deleted.length} leftover sandbox(es). Kept ${keep.slug}.`);
    return;
  }

  const keepIds = lives.flatMap((row) => [row.sandbox_id, row.scout_sandbox_id]).filter(
    (id): id is string => Boolean(id),
  );
  const deleted = await reclaimHoistSandboxes(keepIds);
  console.log(`Reclaimed ${deleted.length} leftover sandbox(es). Kept ${lives.length} live deploy(s).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
