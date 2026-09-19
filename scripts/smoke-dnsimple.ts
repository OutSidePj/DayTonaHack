import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  deleteRecord,
  ensureRecord,
  generateSlug,
  listARecords,
  zoneName,
} from "../lib/dnsimple.js";

const execFileAsync = promisify(execFile);

async function digA(fqdn: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("dig", ["+short", "A", fqdn]);
    return stdout.trim();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function main(): Promise<void> {
  const slug = generateSlug("https://github.com/criesbeck/react-ts-vitest");
  const zone = zoneName();
  const fqdn = `${slug}.${zone}`;
  console.log(`Slug: ${slug}`);
  console.log(`Zone: ${zone}`);
  console.log(`FQDN: ${fqdn}`);
  console.log(`API:  ${process.env.DNSIMPLE_API_BASE ?? "https://api.sandbox.dnsimple.com"}`);

  const first = await ensureRecord(slug);
  console.log(
    `ensureRecord #1 → id=${first.record.id} created=${first.created} updated=${first.updated} content=${first.record.content}`,
  );

  const second = await ensureRecord(slug);
  if (second.record.id !== first.record.id || second.created) {
    throw new Error("ensureRecord is not idempotent — second call created a new record");
  }
  console.log(`ensureRecord #2 → id=${second.record.id} created=${second.created} (idempotent)`);

  const listed = await listARecords(slug);
  if (listed.length !== 1 || listed[0]?.id !== first.record.id) {
    throw new Error(`Expected exactly one A record for ${slug}, got ${JSON.stringify(listed)}`);
  }

  const digAnswer = await digA(fqdn);
  console.log(`dig +short A ${fqdn} → ${digAnswer || "(empty)"}`);
  console.log(
    "DNSimple sandbox has no public authoritative NS, so dig is expected to be empty. Production would return EDGE_IP.",
  );

  await deleteRecord(first.record.id);
  const afterDelete = await listARecords(slug);
  if (afterDelete.length !== 0) {
    throw new Error("deleteRecord left the A record in place");
  }
  await deleteRecord(first.record.id);
  console.log("deleteRecord is idempotent (second delete of the same id is a no-op)");
  console.log("Stage 3 DNSimple smoke test passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
