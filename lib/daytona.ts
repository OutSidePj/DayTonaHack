import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { Daytona, DaytonaError, type Sandbox } from "@daytona/sdk";
import {
  type Manifests,
  type Plan,
  repairPlan,
} from "./planner";

for (const candidate of [
  resolve(process.cwd(), ".env.local"),
  resolve(process.cwd(), "../.env.local"),
]) {
  if (existsSync(candidate)) {
    loadEnv({ path: candidate });
  }
}

/** Placeholder default snapshots. Resources come from the snapshot name.
 *  Scout + run must fit the org concurrency cap (10GiB on the current tier).
 *  small=1GiB, medium=4GiB — two medium lives already leave no room for a new run.
 */
export const HOIST_SNAPSHOT_SCOUT = "daytona-small";
export const HOIST_SNAPSHOT_RUN = "daytona-small";

/** Standalone public Vite + React app with `pnpm build` → `dist`. */
export const SMOKE_REPO_URL = "https://github.com/criesbeck/react-ts-vitest";

export const PREVIEW_PORT = 4173;
export const SANDBOX_TTL_MINUTES = 45;
export const PREVIEW_TOKEN_HEADER = "x-daytona-preview-token";
export const PREVIEW_SKIP_WARNING_HEADER = "X-Daytona-Skip-Preview-Warning";

const CREATE_TIMEOUT_SECONDS = 120;
const INSTALL_TIMEOUT_SECONDS = 360;
const BUILD_TIMEOUT_SECONDS = 300;
const SERVE_POLL_ATTEMPTS = 20;
const SERVE_POLL_MS = 3000;

export type ScoutResult = {
  sandboxId: string;
  commitSha: string;
  repoPath: string;
};

export type RunResult = {
  sandboxId: string;
  repoPath: string;
  port: number;
  previewUrl: string;
  previewToken: string;
};

export type ScoutInspection = ScoutResult & {
  manifests: Manifests;
};

export type LockdownState = "locked" | "unavailable";

export type LockdownResult = {
  state: LockdownState;
  detail: string;
};

export type EgressCheck = {
  target: "https://example.com";
  result: "blocked" | "allowed";
  detail: string;
};

/** Registries + GitHub only. Mutually exclusive with networkBlockAll. */
export const INSTALL_DOMAIN_ALLOWLIST = [
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
  "registry.npmjs.org",
  "registry.npmjs.com",
  "nodejs.org",
  "yarnpkg.com",
  "*.yarnpkg.com",
  "npm.pkg.github.com",
].join(",");

const MANIFEST_NAMES = [
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "Dockerfile",
  "Procfile",
  "vite.config.ts",
  "vite.config.js",
  "vite.config.mts",
  "next.config.ts",
  "next.config.js",
  "next.config.mjs",
  ".env.example",
  ".env.sample",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yaml",
  "requirements.txt",
];
const MANIFEST_MAX_BYTES = 32_000;
const REPAIR_ATTEMPTS = 2;

export type PreviewFetchResult = {
  status: number;
  ok: boolean;
};

function requireApiKey(): string {
  const apiKey = process.env.DAYTONA_API_KEY;
  if (!apiKey) {
    throw new Error(
      "DAYTONA_API_KEY is not set. Create one at https://app.daytona.io/dashboard/keys and put it in .env.local",
    );
  }
  return apiKey;
}

function suffix(): string {
  return randomBytes(3).toString("hex");
}

function assertCommand(
  label: string,
  exitCode: number | undefined,
  output: string,
): void {
  if (exitCode !== 0) {
    throw new Error(`${label} failed (exit ${exitCode ?? "unknown"}):\n${output}`);
  }
}

export function createDaytonaClient(): Daytona {
  return new Daytona({ apiKey: requireApiKey() });
}

async function createSandbox(
  daytona: Daytona,
  role: "scout" | "run",
  snapshot: string,
): Promise<Sandbox> {
  return daytona.create(
    {
      name: `hoist-${role}-${suffix()}`,
      language: "typescript",
      snapshot,
      public: false,
      autoStopInterval: SANDBOX_TTL_MINUTES,
      autoDeleteInterval: SANDBOX_TTL_MINUTES,
      ttlMinutes: SANDBOX_TTL_MINUTES,
      labels: { hoist: "true", role },
    },
    { timeout: CREATE_TIMEOUT_SECONDS },
  );
}

export function createScoutSandbox(daytona: Daytona): Promise<Sandbox> {
  return createSandbox(daytona, "scout", HOIST_SNAPSHOT_SCOUT);
}

export async function createRunSandbox(
  daytona: Daytona,
  opts?: { domainAllowList?: string },
): Promise<Sandbox> {
  try {
    return await daytona.create(
      {
        name: `hoist-run-${suffix()}`,
        language: "typescript",
        snapshot: HOIST_SNAPSHOT_RUN,
        public: false,
        autoStopInterval: SANDBOX_TTL_MINUTES,
        autoDeleteInterval: SANDBOX_TTL_MINUTES,
        ttlMinutes: SANDBOX_TTL_MINUTES,
        labels: { hoist: "true", role: "run" },
        ...(opts?.domainAllowList ? { domainAllowList: opts.domainAllowList } : {}),
      },
      { timeout: CREATE_TIMEOUT_SECONDS },
    );
  } catch (error) {
    if (!opts?.domainAllowList) throw error;
    console.warn(
      `domainAllowList rejected at create (${error instanceof Error ? error.message : error}); retrying without it`,
    );
    return createSandbox(daytona, "run", HOIST_SNAPSHOT_RUN);
  }
}

export async function repoPathFor(sandbox: Sandbox): Promise<string> {
  const workDir = await sandbox.getWorkDir();
  if (!workDir) {
    throw new Error(`Sandbox ${sandbox.id} did not report a working directory`);
  }
  return `${workDir.replace(/\/$/, "")}/repo`;
}

/**
 * Scout: shallow-clone via the SDK, then read HEAD with git CLI only.
 * Never installs or executes repository application code.
 */
export async function scoutCommitSha(
  sandbox: Sandbox,
  repoUrl: string = SMOKE_REPO_URL,
): Promise<ScoutResult> {
  const repoPath = await repoPathFor(sandbox);

  await sandbox.git.clone(
    repoUrl,
    repoPath,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    1,
  );

  const sha = await sandbox.process.executeCommand(
    "git rev-parse HEAD",
    repoPath,
    undefined,
    30,
  );
  assertCommand("git rev-parse HEAD", sha.exitCode, sha.result);
  const commitSha = sha.result.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(commitSha)) {
    throw new Error(`Scout did not return a commit SHA: ${sha.result}`);
  }

  return { sandboxId: sandbox.id, commitSha, repoPath };
}

async function readManifestFile(sandbox: Sandbox, path: string): Promise<string | null> {
  try {
    const buffer = await sandbox.fs.downloadFile(path);
    return buffer.subarray(0, MANIFEST_MAX_BYTES).toString("utf8");
  } catch {
    return null;
  }
}

/** Scout: clone + SHA + read manifests. Never installs or runs repo code. */
export async function scoutRepo(
  sandbox: Sandbox,
  repoUrl: string = SMOKE_REPO_URL,
): Promise<ScoutInspection> {
  const base = await scoutCommitSha(sandbox, repoUrl);
  const entries = await sandbox.fs.listFiles(base.repoPath, { depth: 2 });
  const fileList = entries
    .filter((entry) => !entry.isDir)
    .map((entry) => entry.path ?? `${base.repoPath}/${entry.name}`);

  const files: Record<string, string> = {};
  for (const fullPath of fileList) {
    const name = fullPath.split("/").pop() ?? fullPath;
    if (!MANIFEST_NAMES.includes(name)) continue;
    const body = await readManifestFile(sandbox, fullPath);
    if (body !== null) {
      files[name] = body;
    }
  }

  return { ...base, manifests: { fileList: fileList.map((p) => p.slice(base.repoPath.length + 1) || p), files } };
}

export async function applyNetworkLockdown(
  sandbox: Sandbox,
  extraDomain?: string,
): Promise<LockdownResult> {
  try {
    if (extraDomain) {
      await sandbox.updateNetworkSettings({ domainAllowList: extraDomain });
    } else {
      await sandbox.updateNetworkSettings({ networkBlockAll: true });
    }
    return {
      state: "locked",
      detail: extraDomain ? `domainAllowList=${extraDomain}` : "networkBlockAll",
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { state: "unavailable", detail };
  }
}

export async function checkEgress(sandbox: Sandbox): Promise<EgressCheck> {
  const target = "https://example.com" as const;
  const result = await sandbox.process.executeCommand(
    `curl -m 5 -sS -o /dev/null -w '%{http_code}' ${target} || true`,
    undefined,
    undefined,
    15,
  );
  const code = result.result.trim();
  const allowed = /^(200|301|302|303|307|308)$/.test(code);
  return {
    target,
    result: allowed ? "allowed" : "blocked",
    detail: code || `exit ${result.exitCode}`,
  };
}

async function runCommand(
  sandbox: Sandbox,
  cwd: string,
  command: string,
  timeout: number,
  label: string,
): Promise<string> {
  const result = await sandbox.process.executeCommand(command, cwd, undefined, timeout);
  const output = result.result;
  assertCommand(label, result.exitCode, output);
  return output;
}

export async function executePlan(
  sandbox: Sandbox,
  repoUrl: string,
  commitSha: string,
  plan: Plan,
): Promise<{ repoPath: string; usedPlan: Plan; logs: string }> {
  const repoPath = await repoPathFor(sandbox);
  await sandbox.git.clone(repoUrl, repoPath, undefined, commitSha);

  let current = plan;
  let logs = "";

  for (let attempt = 0; attempt <= REPAIR_ATTEMPTS; attempt += 1) {
    try {
      logs += await runCommand(
        sandbox,
        repoPath,
        current.install,
        INSTALL_TIMEOUT_SECONDS,
        "install",
      );
      if (current.build && current.build !== "true") {
        logs += await runCommand(
          sandbox,
          repoPath,
          current.build,
          BUILD_TIMEOUT_SECONDS,
          "build",
        );
      }
      if (current.static_dir) {
        const dist = await sandbox.process.executeCommand(
          `test -f ${shellQuote(current.static_dir)}/index.html && echo ok`,
          repoPath,
          undefined,
          15,
        );
        assertCommand(`${current.static_dir}/index.html exists`, dist.exitCode, dist.result);
      }
      return { repoPath, usedPlan: current, logs };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logs += `\n${message}\n`;
      if (attempt === REPAIR_ATTEMPTS) {
        throw error;
      }
      current = await repairPlan(current, logs);
    }
  }

  throw new Error("Repair loop exhausted");
}

export async function servePlan(
  sandbox: Sandbox,
  repoPath: string,
  plan: Plan,
): Promise<{ previewUrl: string; previewToken: string; port: number }> {
  const sessionId = `hoist-serve-${Date.now()}`;
  await sandbox.process.createSession(sessionId);
  const serve = await sandbox.process.executeSessionCommand(sessionId, {
    command: `cd ${shellQuote(repoPath)} && ${plan.start}`,
    runAsync: true,
  });
  await waitForLocalServe(sandbox, repoPath, plan.port, serve.cmdId, sessionId);
  const preview = await waitForPreview(sandbox, plan.port);
  return { previewUrl: preview.url, previewToken: preview.token, port: plan.port };
}

const PNPM = "npx --yes pnpm@10.15.1";

async function ensurePnpm(sandbox: Sandbox, cwd: string): Promise<void> {
  const result = await sandbox.process.executeCommand(
    `${PNPM} --version`,
    cwd,
    undefined,
    120,
  );
  assertCommand("pnpm via npx", result.exitCode, result.result);
}

/**
 * Run: clone the scout-pinned SHA, install, build, static-serve dist.
 */
export async function buildAndServe(
  sandbox: Sandbox,
  repoUrl: string,
  commitSha: string,
): Promise<RunResult> {
  const repoPath = await repoPathFor(sandbox);

  await sandbox.git.clone(repoUrl, repoPath, undefined, commitSha);

  await ensurePnpm(sandbox, repoPath);

  const install = await sandbox.process.executeCommand(
    `${PNPM} install --frozen-lockfile=false`,
    repoPath,
    undefined,
    INSTALL_TIMEOUT_SECONDS,
  );
  assertCommand("pnpm install", install.exitCode, install.result);

  const build = await sandbox.process.executeCommand(
    `${PNPM} build`,
    repoPath,
    undefined,
    BUILD_TIMEOUT_SECONDS,
  );
  assertCommand("pnpm build", build.exitCode, build.result);

  const dist = await sandbox.process.executeCommand(
    "test -f dist/index.html && echo ok",
    repoPath,
    undefined,
    15,
  );
  assertCommand("dist/index.html exists", dist.exitCode, dist.result);

  const sessionId = "hoist-static-serve";
  await sandbox.process.createSession(sessionId);
  const serve = await sandbox.process.executeSessionCommand(sessionId, {
    command: `cd ${shellQuote(repoPath)} && npx --yes serve@14 -s dist --listen tcp://0.0.0.0:${PREVIEW_PORT}`,
    runAsync: true,
  });

  await waitForLocalServe(sandbox, repoPath, PREVIEW_PORT, serve.cmdId, sessionId);
  const preview = await waitForPreview(sandbox, PREVIEW_PORT);

  return {
    sandboxId: sandbox.id,
    repoPath,
    port: PREVIEW_PORT,
    previewUrl: preview.url,
    previewToken: preview.token,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function waitForLocalServe(
  sandbox: Sandbox,
  cwd: string,
  port: number,
  cmdId: string | undefined,
  sessionId: string,
): Promise<void> {
  let lastOutput = "";

  for (let attempt = 1; attempt <= SERVE_POLL_ATTEMPTS; attempt += 1) {
    const health = await sandbox.process.executeCommand(
      `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${port} || true`,
      cwd,
      undefined,
      15,
    );
    if (health.result.trim() === "200") {
      return;
    }

    lastOutput = health.result.trim();
    if (cmdId) {
      const logs = await sandbox.process.getSessionCommandLogs(sessionId, cmdId);
      lastOutput = `${lastOutput}\n${logs.stdout ?? ""}\n${logs.stderr ?? ""}`;
    }

    await sleep(SERVE_POLL_MS);
  }

  throw new Error(`Static server never became ready on :${port}:\n${lastOutput}`);
}

async function waitForPreview(
  sandbox: Sandbox,
  port: number,
): Promise<{ url: string; token: string }> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= SERVE_POLL_ATTEMPTS; attempt += 1) {
    try {
      const preview = await sandbox.getPreviewLink(port);
      const check = await fetchPreview(preview.url, preview.token);
      if (check.ok) {
        return { url: preview.url, token: preview.token };
      }
      lastError = new Error(`preview HTTP ${check.status}`);
    } catch (error) {
      lastError = error;
    }

    await sleep(SERVE_POLL_MS);
  }

  throw new Error(
    `Preview did not return HTTP 200 after ${SERVE_POLL_ATTEMPTS} attempts: ${String(lastError)}`,
  );
}

export async function fetchPreview(
  url: string,
  token: string,
): Promise<PreviewFetchResult> {
  const response = await fetch(url, {
    headers: {
      [PREVIEW_TOKEN_HEADER]: token,
      [PREVIEW_SKIP_WARNING_HEADER]: "true",
    },
    redirect: "follow",
  });

  return { status: response.status, ok: response.ok };
}

const START_TIMEOUT_SECONDS = 180;

const NEEDS_START = new Set(["stopped", "archived", "paused", "unknown"]);
const ALREADY_WAKING = new Set([
  "starting",
  "restoring",
  "resuming",
  "creating",
  "pulling_snapshot",
]);

export function sandboxNeedsWake(state: string | undefined): boolean {
  return NEEDS_START.has(state ?? "") || ALREADY_WAKING.has(state ?? "");
}

export async function refreshPreviewLink(
  sandbox: Sandbox,
  port: number,
): Promise<{ url: string; token: string }> {
  const preview = await sandbox.getPreviewLink(port);
  return { url: preview.url, token: preview.token };
}

export async function ensureStaticServe(
  sandbox: Sandbox,
  port: number,
): Promise<void> {
  const repoPath = await repoPathFor(sandbox);
  const health = await sandbox.process.executeCommand(
    `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${port} || true`,
    repoPath,
    undefined,
    15,
  );
  if (health.result.trim() === "200") {
    return;
  }

  const sessionId = `hoist-static-serve-${Date.now()}`;
  await sandbox.process.createSession(sessionId);
  const serve = await sandbox.process.executeSessionCommand(sessionId, {
    command: `cd ${shellQuote(repoPath)} && npx --yes serve@14 -s dist --listen tcp://0.0.0.0:${port}`,
    runAsync: true,
  });
  await waitForLocalServe(sandbox, repoPath, port, serve.cmdId, sessionId);
}

export async function wakeSandboxForPreview(
  sandbox: Sandbox,
  port: number,
): Promise<{ url: string; token: string }> {
  await sandbox.refreshData();
  const state = sandbox.state ?? "";
  if (NEEDS_START.has(state)) {
    await sandbox.start(START_TIMEOUT_SECONDS);
  } else if (ALREADY_WAKING.has(state)) {
    await sandbox.waitUntilStarted(START_TIMEOUT_SECONDS);
  }
  await ensureStaticServe(sandbox, port);
  return refreshPreviewLink(sandbox, port);
}

export async function deleteSandbox(sandbox: Sandbox | undefined): Promise<void> {
  if (!sandbox) return;
  try {
    await sandbox.delete();
  } catch (error) {
    if (error instanceof DaytonaError) {
      console.warn(`Failed to delete sandbox ${sandbox.id}: ${error.message}`);
      return;
    }
    throw error;
  }
}

export async function listHoistSandboxes(): Promise<Sandbox[]> {
  const daytona = createDaytonaClient();
  const found: Sandbox[] = [];
  for await (const sandbox of daytona.list({ labels: { hoist: "true" } })) {
    found.push(sandbox);
  }
  return found;
}

export async function reclaimHoistSandboxes(keepIds: Iterable<string> = []): Promise<string[]> {
  const keep = new Set([...keepIds].filter(Boolean));
  const deleted: string[] = [];
  for (const sandbox of await listHoistSandboxes()) {
    if (keep.has(sandbox.id)) continue;
    await deleteSandbox(sandbox);
    deleted.push(sandbox.id);
  }
  return deleted;
}

export function isMemoryLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /memory limit exceeded/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
