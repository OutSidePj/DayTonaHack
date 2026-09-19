import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { EgressCheck, LockdownResult } from "./daytona";
import { publish } from "./events";
import { deploymentsPath, routesPath } from "./paths";
import type { Plan } from "./planner";
import type { GpuStatus } from "./nosana";

export type DeployStage =
  | "queued"
  | "scouting"
  | "planning"
  | "building"
  | "locking"
  | "routing"
  | "live"
  | "failed";

export type DeployEvent = {
  stage: DeployStage | "error";
  message: string;
  at: string;
};

export type DeploymentRecord = {
  id: string;
  repo_url: string;
  commit_sha: string | null;
  slug: string;
  status: DeployStage;
  sandbox_id: string | null;
  scout_sandbox_id: string | null;
  port: number | null;
  preview_url: string | null;
  preview_token: string | null;
  dns_record_id: string | null;
  plan: Plan | null;
  lockdown: LockdownResult | null;
  egress: EgressCheck | null;
  gpu: boolean;
  gpu_status: GpuStatus | null;
  gpu_url: string | null;
  public_url: string | null;
  dns_name: string | null;
  error: string | null;
  events: DeployEvent[];
  expires_at: string | null;
  created_at: string;
};

export type DeploymentRoute = {
  id: string;
  slug: string;
  sandboxId: string;
  port: number;
  previewUrl: string;
  previewToken: string;
  status: string;
};

export type DeploymentPatch = Partial<Omit<DeploymentRecord, "id" | "created_at" | "events">>;

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readDeployments(): DeploymentRecord[] {
  return readJson<DeploymentRecord[]>(deploymentsPath(), []);
}

function writeDeployments(rows: DeploymentRecord[]): void {
  writeJson(deploymentsPath(), rows);
}

export function readRoutes(): DeploymentRoute[] {
  return readJson<DeploymentRoute[]>(routesPath(), []);
}

export function writeRoute(route: DeploymentRoute): void {
  const rows = readRoutes().filter((row) => row.slug !== route.slug && row.id !== route.id);
  rows.push(route);
  writeJson(routesPath(), rows);
}

export function removeRoute(idOrSlug: string): void {
  writeJson(
    routesPath(),
    readRoutes().filter((row) => row.id !== idOrSlug && row.slug !== idOrSlug),
  );
}

export function routeBySlug(slug: string): DeploymentRoute | null {
  return readRoutes().find((row) => row.slug === slug) ?? null;
}

function supabaseEnv(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url, key };
}

function supabase(): SupabaseClient | null {
  const env = supabaseEnv();
  if (!env) return null;
  return createClient(env.url, env.key, { auth: { persistSession: false } });
}

function fromRow(row: Record<string, unknown>): DeploymentRecord {
  return {
    id: String(row.id),
    repo_url: String(row.repo_url),
    commit_sha: (row.commit_sha as string | null) ?? null,
    slug: String(row.slug),
    status: (row.status as DeployStage) ?? "queued",
    sandbox_id: (row.sandbox_id as string | null) ?? null,
    scout_sandbox_id: (row.scout_sandbox_id as string | null) ?? null,
    port: (row.port as number | null) ?? null,
    preview_url: (row.preview_url as string | null) ?? null,
    preview_token: (row.preview_token as string | null) ?? null,
    dns_record_id: row.dns_record_id == null ? null : String(row.dns_record_id),
    plan: (row.plan as Plan | null) ?? null,
    lockdown: (row.lockdown as LockdownResult | null) ?? null,
    egress: (row.egress as EgressCheck | null) ?? null,
    gpu: Boolean(row.gpu),
    gpu_status: (row.gpu_status as GpuStatus | null) ?? null,
    gpu_url: (row.gpu_url as string | null) ?? null,
    public_url: (row.public_url as string | null) ?? null,
    dns_name: (row.dns_name as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    events: Array.isArray(row.events) ? (row.events as DeployEvent[]) : [],
    expires_at: (row.expires_at as string | null) ?? null,
    created_at: String(row.created_at),
  };
}

export async function createRecord(record: DeploymentRecord): Promise<DeploymentRecord> {
  const client = supabase();
  if (client) {
    const { error } = await client.from("deployments").insert(record);
    if (error) {
      throw new Error(`Supabase insert failed: ${error.message}`);
    }
    return record;
  }

  const rows = readDeployments();
  rows.push(record);
  writeDeployments(rows);
  return record;
}

export async function listRecords(): Promise<DeploymentRecord[]> {
  const client = supabase();
  if (client) {
    const { data, error } = await client.from("deployments").select("*");
    if (error) {
      throw new Error(`Supabase list failed: ${error.message}`);
    }
    return (data ?? []).map((row) => fromRow(row as Record<string, unknown>));
  }
  return readDeployments();
}

export async function getRecord(id: string): Promise<DeploymentRecord | null> {
  const client = supabase();
  if (client) {
    const { data, error } = await client.from("deployments").select("*").eq("id", id).maybeSingle();
    if (error) {
      throw new Error(`Supabase get failed: ${error.message}`);
    }
    return data ? fromRow(data as Record<string, unknown>) : null;
  }

  return readDeployments().find((row) => row.id === id) ?? null;
}

export async function updateRecord(
  id: string,
  patch: DeploymentPatch,
  event?: DeployEvent,
): Promise<DeploymentRecord> {
  const current = await getRecord(id);
  if (!current) {
    throw new Error(`Deployment ${id} not found`);
  }

  const next: DeploymentRecord = {
    ...current,
    ...patch,
    events: event ? [...current.events, event] : current.events,
  };

  const client = supabase();
  if (client) {
    const { error } = await client.from("deployments").update(next).eq("id", id);
    if (error) {
      throw new Error(`Supabase update failed: ${error.message}`);
    }
  } else {
    writeDeployments(readDeployments().map((row) => (row.id === id ? next : row)));
  }

  if (event) {
    publish(id, event, next);
  }
  return next;
}

export async function deleteDeployment(id: string): Promise<void> {
  const client = supabase();
  if (client) {
    const { error } = await client.from("deployments").delete().eq("id", id);
    if (error) {
      throw new Error(`Supabase delete failed: ${error.message}`);
    }
    return;
  }
  writeDeployments(readDeployments().filter((row) => row.id !== id));
}

export function usingSupabase(): boolean {
  return supabaseEnv() !== null;
}
