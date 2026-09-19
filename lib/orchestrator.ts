import { randomUUID } from "node:crypto";
import {
  INSTALL_DOMAIN_ALLOWLIST,
  SANDBOX_TTL_MINUTES,
  applyNetworkLockdown,
  checkEgress,
  createDaytonaClient,
  createRunSandbox,
  createScoutSandbox,
  deleteSandbox,
  executePlan,
  isMemoryLimitError,
  listHoistSandboxes,
  reclaimHoistSandboxes,
  scoutRepo,
  servePlan,
} from "./daytona";
import { deleteRecord, ensureRecord, generateSlug, zoneName } from "./dnsimple";
import { attachGpuToSandbox, ensureGpuBackend } from "./nosana";
import { DeployBlockedError, assertDeployable, decidePlan } from "./planner";
import {
  type DeployEvent,
  type DeploymentRecord,
  createRecord,
  deleteDeployment,
  getRecord,
  listRecords,
  removeRoute,
  updateRecord,
  writeRoute,
} from "./store";

const GITHUB_REPO = /^https:\/\/github\.com\/[^/]+\/[^/]+?(?:\.git)?\/?$/i;

type Jobs = Map<string, Promise<void>>;
const globalJobs = globalThis as typeof globalThis & { __hoistJobs?: Jobs };

function jobs(): Jobs {
  if (!globalJobs.__hoistJobs) {
    globalJobs.__hoistJobs = new Map();
  }
  return globalJobs.__hoistJobs;
}

export function proxyPort(): number {
  return Number(process.env.PROXY_PORT ?? 8080);
}

export function localUrl(slug: string): string {
  return `http://${slug}.localhost:${proxyPort()}`;
}

export function dnsName(slug: string): string {
  return `${slug}.${process.env.PREVIEW_BASE_DOMAIN ?? zoneName()}`;
}

export function parseRepoUrl(input: string): string {
  const repoUrl = input.trim().replace(/\/$/, "");
  if (!GITHUB_REPO.test(repoUrl)) {
    throw new Error("repoUrl must be an https://github.com/owner/repo URL");
  }
  return repoUrl.replace(/\.git$/i, "");
}

async function emit(
  id: string,
  stage: DeploymentRecord["status"] | "error",
  message: string,
  patch: Parameters<typeof updateRecord>[1] = {},
): Promise<DeploymentRecord> {
  const event: DeployEvent = {
    stage,
    message,
    at: new Date().toISOString(),
  };
  const status = stage === "error" ? "failed" : stage;
  return updateRecord(id, { ...patch, status }, event);
}

export async function startDeploy(input: {
  repoUrl: string;
  gpu?: boolean;
}): Promise<{ id: string }> {
  const repoUrl = parseRepoUrl(input.repoUrl);
  const id = randomUUID();
  const slug = generateSlug(repoUrl);
  const createdAt = new Date();
  const expires = new Date(createdAt.getTime() + SANDBOX_TTL_MINUTES * 60_000);

  const record: DeploymentRecord = {
    id,
    repo_url: repoUrl,
    commit_sha: null,
    slug,
    status: "queued",
    sandbox_id: null,
    scout_sandbox_id: null,
    port: null,
    preview_url: null,
    preview_token: null,
    dns_record_id: null,
    plan: null,
    lockdown: null,
    egress: null,
    gpu: Boolean(input.gpu),
    gpu_status: input.gpu ? "warming" : null,
    gpu_url: null,
    public_url: localUrl(slug),
    dns_name: dnsName(slug),
    error: null,
    events: [],
    expires_at: expires.toISOString(),
    created_at: createdAt.toISOString(),
  };

  await createRecord(record);
  const work = runDeploy(id).finally(() => jobs().delete(id));
  jobs().set(id, work);
  return { id };
}

export async function runDeploy(id: string): Promise<void> {
  const daytona = createDaytonaClient();
  let scout: Awaited<ReturnType<typeof createScoutSandbox>> | undefined;
  let run: Awaited<ReturnType<typeof createRunSandbox>> | undefined;

  try {
    const current = await getRecord(id);
    if (!current) {
      throw new Error(`Deployment ${id} not found`);
    }

    await emit(id, "scouting", `Shallow-clone ${current.repo_url}`);
    await reclaimOrphans(id);
    scout = await createScoutSandbox(daytona);
    await updateRecord(id, { scout_sandbox_id: scout.id });
    const inspection = await scoutRepo(scout, current.repo_url);
    await updateRecord(id, { commit_sha: inspection.commitSha });
    await deleteSandbox(scout);
    scout = undefined;

    await emit(id, "planning", `Pinned ${inspection.commitSha.slice(0, 7)}`);
    const plan = await decidePlan(inspection.manifests);
    assertDeployable(plan);
    await updateRecord(id, { plan });

    let gpuBackend = null;
    if (current.gpu) {
      await updateRecord(id, { gpu_status: "warming" });
      gpuBackend = await ensureGpuBackend();
      await updateRecord(id, { gpu_status: gpuBackend.status, gpu_url: gpuBackend.url });
    }

    await emit(id, "building", `${plan.runtime} / ${plan.package_manager}`);
    await reclaimOrphans(id);
    try {
      run = await createRunSandbox(daytona, {
        domainAllowList: INSTALL_DOMAIN_ALLOWLIST,
      });
    } catch (error) {
      if (!isMemoryLimitError(error)) throw error;
      await emit(
        id,
        "building",
        "Org memory cap hit — reclaiming older Hoist sandboxes",
      );
      await reclaimOldestLives(id);
      try {
        run = await createRunSandbox(daytona, {
          domainAllowList: INSTALL_DOMAIN_ALLOWLIST,
        });
      } catch (retryError) {
        if (isMemoryLimitError(retryError)) {
          throw new Error(
            "Daytona org memory cap (10GiB) is still full after reclaiming old Hoist sandboxes. Delete leftover sandboxes at https://app.daytona.io/dashboard or wait for the 45 min TTL.",
          );
        }
        throw retryError;
      }
    }
    await updateRecord(id, { sandbox_id: run.id });
    const built = await executePlan(run, current.repo_url, inspection.commitSha, plan);

    await emit(id, "locking", gpuBackend ? "Allow only Nosana host" : "Block outbound traffic");
    const lockdown = gpuBackend
      ? await attachGpuToSandbox(run, gpuBackend)
      : await applyNetworkLockdown(run);
    const egress = await checkEgress(run);
    await updateRecord(id, { lockdown, egress });

    const served = await servePlan(run, built.repoPath, built.usedPlan);
    await updateRecord(id, {
      port: served.port,
      preview_url: served.previewUrl,
      preview_token: served.previewToken,
    });

    await emit(id, "routing", `Register ${current.slug}`);
    writeRoute({
      id,
      slug: current.slug,
      sandboxId: run.id,
      port: served.port,
      previewUrl: served.previewUrl,
      previewToken: served.previewToken,
      status: "live",
    });

    let dnsRecordId: string | null = null;
    try {
      const dns = await ensureRecord(current.slug);
      dnsRecordId = String(dns.record.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateRecord(id, {}, {
        stage: "routing",
        message: `DNS skipped: ${message}`,
        at: new Date().toISOString(),
      });
    }

    await emit(id, "live", localUrl(current.slug), {
      dns_record_id: dnsRecordId,
      public_url: localUrl(current.slug),
      sandbox_id: run.id,
      port: served.port,
      preview_url: served.previewUrl,
      preview_token: served.previewToken,
      lockdown,
      egress,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = error instanceof DeployBlockedError ? error.message : message;
    await emit(id, "error", failed, { error: failed }).catch(() => undefined);
    if (run) {
      await deleteSandbox(run);
    }
    if (scout) {
      await deleteSandbox(scout);
    }
    removeRoute(id);
  }
}

export async function teardownDeploy(id: string): Promise<void> {
  const record = await getRecord(id);
  if (!record) {
    throw new Error(`Deployment ${id} not found`);
  }

  const daytona = createDaytonaClient();
  if (record.sandbox_id) {
    try {
      await deleteSandbox(await daytona.get(record.sandbox_id));
    } catch (error) {
      console.warn(
        `Teardown sandbox ${record.sandbox_id}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  if (record.scout_sandbox_id) {
    try {
      await deleteSandbox(await daytona.get(record.scout_sandbox_id));
    } catch {
      // Scout is usually already gone.
    }
  }
  if (record.dns_record_id) {
    await deleteRecord(Number(record.dns_record_id));
  }
  removeRoute(id);
  await deleteDeployment(id);
}

export async function snapshot(id: string): Promise<DeploymentRecord> {
  const record = await getRecord(id);
  if (!record) {
    throw new Error(`Deployment ${id} not found`);
  }
  return record;
}

async function liveSandboxIds(exceptId?: string): Promise<string[]> {
  const rows = await listRecords();
  return rows
    .filter((row) => row.status === "live" && row.id !== exceptId)
    .flatMap((row) => [row.sandbox_id, row.scout_sandbox_id])
    .filter((value): value is string => Boolean(value));
}

async function reclaimOrphans(currentId: string): Promise<void> {
  const keep = new Set(await liveSandboxIds(currentId));
  const current = await getRecord(currentId);
  if (current?.sandbox_id) keep.add(current.sandbox_id);
  if (current?.scout_sandbox_id) keep.add(current.scout_sandbox_id);
  const known = new Set(keep);
  for (const box of await listHoistSandboxes()) {
    if (!known.has(box.id)) {
      await deleteSandbox(box);
    }
  }
}

async function reclaimOldestLives(currentId: string): Promise<void> {
  const lives = (await listRecords())
    .filter((row) => row.status === "live" && row.id !== currentId)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  for (const row of lives) {
    await teardownDeploy(row.id);
  }
  await reclaimHoistSandboxes(await liveSandboxIds(currentId));
}
