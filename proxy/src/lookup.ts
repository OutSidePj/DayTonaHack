import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  type DeploymentRoute,
  readRoutes,
  removeRoute,
  routeBySlug,
  writeRoute,
} from "../../lib/store.js";

export type { DeploymentRoute };

export interface DeploymentStore {
  getBySlug(slug: string): Promise<DeploymentRoute | null>;
  updatePreview(id: string, previewUrl: string, previewToken: string): Promise<void>;
  list(): Promise<DeploymentRoute[]>;
}

const CACHE_TTL_MS = 15_000;

type CacheEntry = {
  route: DeploymentRoute;
  expiresAt: number;
};

export class CachedStore implements DeploymentStore {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly inner: DeploymentStore) {}

  async getBySlug(slug: string): Promise<DeploymentRoute | null> {
    const hit = this.cache.get(slug);
    if (hit && hit.expiresAt > Date.now()) {
      return hit.route;
    }

    const route = await this.inner.getBySlug(slug);
    if (route) {
      this.cache.set(slug, { route, expiresAt: Date.now() + CACHE_TTL_MS });
    } else {
      this.cache.delete(slug);
    }
    return route;
  }

  async updatePreview(
    id: string,
    previewUrl: string,
    previewToken: string,
  ): Promise<void> {
    await this.inner.updatePreview(id, previewUrl, previewToken);
    for (const [slug, entry] of this.cache) {
      if (entry.route.id === id) {
        this.cache.set(slug, {
          route: { ...entry.route, previewUrl, previewToken },
          expiresAt: Date.now() + CACHE_TTL_MS,
        });
      }
    }
  }

  async list(): Promise<DeploymentRoute[]> {
    return this.inner.list();
  }

  invalidate(slug: string): void {
    this.cache.delete(slug);
  }
}

export class FileStore implements DeploymentStore {
  constructor() {}

  seed(route: DeploymentRoute): void {
    writeRoute(route);
  }

  remove(idOrSlug: string): void {
    removeRoute(idOrSlug);
  }

  async getBySlug(slug: string): Promise<DeploymentRoute | null> {
    return routeBySlug(slug);
  }

  async updatePreview(
    id: string,
    previewUrl: string,
    previewToken: string,
  ): Promise<void> {
    const current = readRoutes().find((row) => row.id === id);
    if (!current) return;
    writeRoute({ ...current, previewUrl, previewToken });
  }

  async list(): Promise<DeploymentRoute[]> {
    return readRoutes();
  }
}

type DeploymentRow = {
  id: string;
  slug: string;
  sandbox_id: string | null;
  port: number | null;
  preview_url: string | null;
  preview_token: string | null;
  status: string;
};

export class SupabaseStore implements DeploymentStore {
  constructor(private readonly client: SupabaseClient) {}

  async getBySlug(slug: string): Promise<DeploymentRoute | null> {
    const { data, error } = await this.client
      .from("deployments")
      .select("id, slug, sandbox_id, port, preview_url, preview_token, status")
      .eq("slug", slug)
      .maybeSingle<DeploymentRow>();

    if (error) {
      throw new Error(`Supabase lookup failed: ${error.message}`);
    }
    if (!data?.sandbox_id || !data.port || !data.preview_url || !data.preview_token) {
      return null;
    }

    return {
      id: data.id,
      slug: data.slug,
      sandboxId: data.sandbox_id,
      port: data.port,
      previewUrl: data.preview_url,
      previewToken: data.preview_token,
      status: data.status,
    };
  }

  async updatePreview(
    id: string,
    previewUrl: string,
    previewToken: string,
  ): Promise<void> {
    const { error } = await this.client
      .from("deployments")
      .update({ preview_url: previewUrl, preview_token: previewToken })
      .eq("id", id);

    if (error) {
      throw new Error(`Supabase preview update failed: ${error.message}`);
    }
  }

  async list(): Promise<DeploymentRoute[]> {
    const { data, error } = await this.client
      .from("deployments")
      .select("id, slug, sandbox_id, port, preview_url, preview_token, status");

    if (error) {
      throw new Error(`Supabase list failed: ${error.message}`);
    }

    return (data ?? [])
      .filter((row) => row.sandbox_id && row.port && row.preview_url && row.preview_token)
      .map((row) => ({
        id: row.id,
        slug: row.slug,
        sandboxId: row.sandbox_id as string,
        port: row.port as number,
        previewUrl: row.preview_url as string,
        previewToken: row.preview_token as string,
        status: row.status,
      }));
  }
}

export const fileStore = new FileStore();

export function seedLocalRoute(route: DeploymentRoute): void {
  fileStore.seed(route);
}

export function removeLocalRoute(idOrSlug: string): void {
  fileStore.remove(idOrSlug);
}

export function createStore(): CachedStore {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (url && key) {
    return new CachedStore(
      new SupabaseStore(createClient(url, key, { auth: { persistSession: false } })),
    );
  }

  console.warn(
    "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY unset — using .hoist/routes.json",
  );
  return new CachedStore(fileStore);
}
