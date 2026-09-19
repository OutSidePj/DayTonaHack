import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";

for (const candidate of [
  resolve(process.cwd(), ".env.local"),
  resolve(process.cwd(), "../.env.local"),
]) {
  if (existsSync(candidate)) {
    loadEnv({ path: candidate });
  }
}

/** Sandbox while developing. Production is https://api.dnsimple.com */
export const DNSIMPLE_SANDBOX_API = "https://api.sandbox.dnsimple.com";

export type ZoneRecord = {
  id: number;
  zone_id: string;
  name: string;
  content: string;
  ttl: number;
  type: string;
};

export type EnsureRecordResult = {
  record: ZoneRecord;
  created: boolean;
  updated: boolean;
};

type DnsimpleEnvelope<T> = {
  data: T;
  message?: string;
  pagination?: {
    current_page: number;
    per_page: number;
    total_entries: number;
    total_pages: number;
  };
};

function apiBase(): string {
  return (process.env.DNSIMPLE_API_BASE ?? DNSIMPLE_SANDBOX_API).replace(/\/$/, "");
}

function requireToken(): string {
  const token = process.env.DNSIMPLE_API_TOKEN;
  if (!token) {
    throw new Error(
      "DNSIMPLE_API_TOKEN is not set. Create a sandbox token at https://sandbox.dnsimple.com and add it to .env.local",
    );
  }
  return token;
}

export function zoneName(): string {
  const zone = process.env.DNSIMPLE_ZONE ?? process.env.PREVIEW_BASE_DOMAIN;
  if (!zone) {
    throw new Error("PREVIEW_BASE_DOMAIN (or DNSIMPLE_ZONE) is not set");
  }
  return zone;
}

export function edgeIp(): string {
  const ip = process.env.EDGE_IP;
  if (!ip) {
    throw new Error("EDGE_IP is not set");
  }
  return ip;
}

async function dnsimple<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; payload: T | null }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${requireToken()}`,
    Accept: "application/json",
    "User-Agent": "hoist/0.1",
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${apiBase()}/v2${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) {
    return { status: 204, payload: null };
  }

  const payload = (await response.json()) as T & { message?: string };
  if (!response.ok) {
    throw new Error(
      `DNSimple ${method} ${path} failed (${response.status}): ${payload.message ?? JSON.stringify(payload)}`,
    );
  }
  return { status: response.status, payload };
}

export async function resolveAccountId(): Promise<number> {
  if (process.env.DNSIMPLE_ACCOUNT_ID) {
    return Number(process.env.DNSIMPLE_ACCOUNT_ID);
  }

  const { payload } = await dnsimple<
    DnsimpleEnvelope<{ account: { id: number } | null; user: unknown }>
  >("GET", "/whoami");
  const accountId = payload?.data.account?.id;
  if (!accountId) {
    throw new Error(
      "DNSIMPLE_ACCOUNT_ID is not set and whoami did not return an account (user tokens need the account id)",
    );
  }
  return accountId;
}

export function generateSlug(repoUrl: string): string {
  const trimmed = repoUrl.trim().replace(/\.git$/i, "");
  const repo = trimmed.split("/").filter(Boolean).at(-1) ?? "app";
  const base = repo
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 58) || "app";
  const suffix = randomBytes(3).toString("hex").slice(0, 4);
  return `${base}-${suffix}`;
}

export async function listARecords(name: string): Promise<ZoneRecord[]> {
  const accountId = await resolveAccountId();
  const zone = zoneName();
  const query = new URLSearchParams({ name, type: "A", per_page: "100" });
  const { payload } = await dnsimple<DnsimpleEnvelope<ZoneRecord[]>>(
    "GET",
    `/${accountId}/zones/${encodeURIComponent(zone)}/records?${query}`,
  );
  return payload?.data ?? [];
}

export async function ensureRecord(
  slug: string,
  ip: string = edgeIp(),
): Promise<EnsureRecordResult> {
  const accountId = await resolveAccountId();
  const zone = zoneName();
  const existing = await listARecords(slug);
  const match = existing[0];

  if (match && match.content === ip) {
    return { record: match, created: false, updated: false };
  }

  if (match) {
    const { payload } = await dnsimple<DnsimpleEnvelope<ZoneRecord>>(
      "PATCH",
      `/${accountId}/zones/${encodeURIComponent(zone)}/records/${match.id}`,
      { content: ip },
    );
    if (!payload?.data) {
      throw new Error("DNSimple update returned no record");
    }
    return { record: payload.data, created: false, updated: true };
  }

  const { payload } = await dnsimple<DnsimpleEnvelope<ZoneRecord>>(
    "POST",
    `/${accountId}/zones/${encodeURIComponent(zone)}/records`,
    { name: slug, type: "A", content: ip, ttl: 60 },
  );
  if (!payload?.data) {
    throw new Error("DNSimple create returned no record");
  }
  return { record: payload.data, created: true, updated: false };
}

export async function deleteRecord(recordId: number): Promise<void> {
  const accountId = await resolveAccountId();
  const zone = zoneName();
  try {
    await dnsimple(
      "DELETE",
      `/${accountId}/zones/${encodeURIComponent(zone)}/records/${recordId}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("(404)")) {
      return;
    }
    throw error;
  }
}
