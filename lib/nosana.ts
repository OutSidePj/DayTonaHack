import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import type { Sandbox } from "@daytona/sdk";
import { applyNetworkLockdown, type LockdownResult } from "./daytona";

for (const candidate of [
  resolve(process.cwd(), ".env.local"),
  resolve(process.cwd(), "../.env.local"),
]) {
  if (existsSync(candidate)) {
    loadEnv({ path: candidate });
  }
}

/** Production proxy from https://learn.nosana.com/api/intro.html */
export const NOSANA_PRODUCTION_API = "https://api.nosana.com";

/** Existing MiniMax Music 3 ComfyUI deployment (v1 looks this up; does not create). */
export const MINIMAX_DEPLOYMENT_ID = "Fer6nhBMULfvw1BWpqoxA9HRvNSr8jLarFGDkJk8WLk9";

/** Live demo endpoint for that deployment. */
export const MINIMAX_COMFY_URL =
  "https://3em3edqmfQLc1vUSaYTtScpF7py8uktGXqqskx5tKBaQ.node.k8s.prd.nos.ci";

export const GPU_ENV_NAME = "NOSANA_COMFY_URL";

const HEALTH_PATH = "/system_stats";
const HEALTH_TIMEOUT_MS = 15_000;
const WARM_POLL_MS = 10_000;
const WARM_TIMEOUT_MS = 5 * 60_000;

export const STARTABLE_STATUSES = new Set(["DRAFT", "STOPPED"]);
export const RUNNING_STATUSES = new Set(["RUNNING", "STARTING"]);

export type DeploymentStatus =
  | "DRAFT"
  | "ERROR"
  | "STARTING"
  | "RUNNING"
  | "STOPPING"
  | "STOPPED"
  | "INSUFFICIENT_FUNDS"
  | "ARCHIVED"
  | string;

export type GpuStatus = "warming" | "ready";

export type NosanaEndpoint = {
  opId: string;
  port: number | string;
  url: string;
  online: boolean;
};

export type NosanaDeployment = {
  id: string;
  name?: string;
  status: DeploymentStatus;
  endpoints: NosanaEndpoint[];
  active_jobs?: number;
};

export type ComfyHealth = {
  ok: boolean;
  status: number;
  url: string;
  devices: number;
  os?: string;
  detail: string;
};

export type GpuBackend = {
  status: GpuStatus;
  url: string;
  host: string;
  deploymentId: string;
  deploymentStatus?: DeploymentStatus;
  health: ComfyHealth;
  started: boolean;
  source: "api" | "demo-url";
};

function apiBase(): string {
  return (process.env.NOSANA_API_BASE ?? NOSANA_PRODUCTION_API).replace(/\/$/, "");
}

export function nosanaApiKey(): string | undefined {
  const key = process.env.NOSANA_API_KEY?.trim();
  return key || undefined;
}

export function deploymentId(): string {
  return process.env.NOSANA_DEPLOYMENT_ID?.trim() || MINIMAX_DEPLOYMENT_ID;
}

export function demoComfyUrl(): string {
  return (process.env.NOSANA_COMFY_URL?.trim() || MINIMAX_COMFY_URL).replace(/\/$/, "");
}

export function hostFromUrl(url: string): string {
  return new URL(url).host;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseEndpoints(value: unknown): NosanaEndpoint[] {
  if (!Array.isArray(value)) return [];
  const out: NosanaEndpoint[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    if (!rec || typeof rec.url !== "string" || !rec.url) continue;
    out.push({
      opId: typeof rec.opId === "string" ? rec.opId : "",
      port: typeof rec.port === "number" || typeof rec.port === "string" ? rec.port : 0,
      url: rec.url.replace(/\/$/, ""),
      online: rec.online === true,
    });
  }
  return out;
}

function parseDeployment(payload: unknown): NosanaDeployment {
  const root = asRecord(payload);
  const data = asRecord(root?.data) ?? root;
  if (!data || typeof data.id !== "string" || typeof data.status !== "string") {
    throw new Error(`Unexpected Nosana deployment payload: ${JSON.stringify(payload)}`);
  }
  return {
    id: data.id,
    name: typeof data.name === "string" ? data.name : undefined,
    status: data.status,
    endpoints: parseEndpoints(data.endpoints),
    active_jobs: typeof data.active_jobs === "number" ? data.active_jobs : undefined,
  };
}

export function publicUrlFromDeployment(deployment: NosanaDeployment): string | undefined {
  const online = deployment.endpoints.find((endpoint) => endpoint.online && endpoint.url);
  return (online ?? deployment.endpoints.find((endpoint) => endpoint.url))?.url;
}

async function nosana<T>(method: string, path: string): Promise<{ status: number; payload: T }> {
  const key = nosanaApiKey();
  if (!key) {
    throw new Error(
      "NOSANA_API_KEY is not set. Create one at https://deploy.nosana.com and add it to .env.local",
    );
  }

  const response = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    },
  });

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Nosana ${method} ${path} returned non-JSON (${response.status}): ${text}`);
    }
  }

  if (!response.ok) {
    throw new Error(
      `Nosana ${method} ${path} failed (${response.status}): ${text || response.statusText}`,
    );
  }

  return { status: response.status, payload: payload as T };
}

export async function getDeployment(id: string = deploymentId()): Promise<NosanaDeployment> {
  const { payload } = await nosana<unknown>("GET", `/deployments/${id}`);
  return parseDeployment(payload);
}

export async function startDeployment(id: string = deploymentId()): Promise<{
  status: "STARTING";
  updated_at: string;
}> {
  const { payload } = await nosana<unknown>("POST", `/deployments/${id}/start`);
  const rec = asRecord(payload);
  if (!rec || rec.status !== "STARTING" || typeof rec.updated_at !== "string") {
    throw new Error(`Unexpected Nosana start payload: ${JSON.stringify(payload)}`);
  }
  return { status: "STARTING", updated_at: rec.updated_at };
}

export async function healthCheckComfy(url: string = demoComfyUrl()): Promise<ComfyHealth> {
  const target = `${url.replace(/\/$/, "")}${HEALTH_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(target, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    const text = await response.text();
    let devices = 0;
    let os: string | undefined;
    if (response.ok) {
      try {
        const body = JSON.parse(text) as { system?: { os?: string }; devices?: unknown[] };
        devices = Array.isArray(body.devices) ? body.devices.length : 0;
        os = body.system?.os;
      } catch {
        return {
          ok: false,
          status: response.status,
          url: target,
          devices: 0,
          detail: `non-JSON body: ${text.slice(0, 200)}`,
        };
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      url: target,
      devices,
      os,
      detail: response.ok ? `devices=${devices}` : text.slice(0, 200) || response.statusText,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      url: target,
      devices: 0,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function ensureGpuBackend(opts?: {
  onStatus?: (status: GpuStatus, detail: string) => void;
}): Promise<GpuBackend> {
  const report = (status: GpuStatus, detail: string) => opts?.onStatus?.(status, detail);
  report("warming", "looking up MiniMax ComfyUI");

  const id = deploymentId();
  let url = demoComfyUrl();
  let source: GpuBackend["source"] = "demo-url";
  let deploymentStatus: DeploymentStatus | undefined;
  let started = false;

  if (nosanaApiKey()) {
    let deployment = await getDeployment(id);
    deploymentStatus = deployment.status;
    report("warming", `deployment ${id} status=${deployment.status}`);

    if (STARTABLE_STATUSES.has(deployment.status)) {
      await startDeployment(id);
      started = true;
      deploymentStatus = "STARTING";
      report("warming", "start requested");
    }

    const deadline = Date.now() + WARM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      deployment = await getDeployment(id);
      deploymentStatus = deployment.status;
      const fromApi = publicUrlFromDeployment(deployment);
      if (fromApi) {
        url = fromApi;
        source = "api";
      }
      if (deployment.status === "RUNNING" || fromApi) break;
      if (deployment.status === "ERROR" || deployment.status === "INSUFFICIENT_FUNDS") {
        throw new Error(`Nosana deployment ${id} is ${deployment.status}`);
      }
      if (deployment.status === "ARCHIVED") {
        throw new Error(`Nosana deployment ${id} is ARCHIVED and cannot be restarted`);
      }
      report("warming", `status=${deployment.status}`);
      await sleep(WARM_POLL_MS);
    }
  } else {
    report("warming", "no NOSANA_API_KEY; using demo ComfyUI URL");
  }

  const healthDeadline = Date.now() + WARM_TIMEOUT_MS;
  let health = await healthCheckComfy(url);
  while (!health.ok && Date.now() < healthDeadline) {
    report("warming", `ComfyUI ${health.status || "down"} (${health.detail})`);
    await sleep(WARM_POLL_MS);
    health = await healthCheckComfy(url);
  }

  if (!health.ok) {
    throw new Error(`ComfyUI did not become ready at ${url}: ${health.detail}`);
  }

  const backend: GpuBackend = {
    status: "ready",
    url,
    host: hostFromUrl(url),
    deploymentId: id,
    deploymentStatus,
    health,
    started,
    source,
  };
  report("ready", `${url} (${health.detail})`);
  return backend;
}

export async function attachGpuToSandbox(
  sandbox: Sandbox,
  backend: GpuBackend,
): Promise<LockdownResult> {
  await sandbox.updateEnv({ [GPU_ENV_NAME]: backend.url });
  return applyNetworkLockdown(sandbox, backend.host);
}
