import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { DaytonaError, SandboxState, type Sandbox } from "@daytona/sdk";
import httpProxy from "http-proxy";
import {
  PREVIEW_SKIP_WARNING_HEADER,
  PREVIEW_TOKEN_HEADER,
  createDaytonaClient,
  wakeSandboxForPreview,
} from "../../lib/daytona.js";
import { slugFromHost } from "./host.js";
import {
  createStore,
  type CachedStore,
  type DeploymentRoute,
} from "./lookup.js";
import { messagePage, statusPage, unknownSlugPage } from "./pages.js";
import { wakingPage } from "./waking.js";

const PROXY_PORT = Number(process.env.PROXY_PORT ?? 8080);
const previewHeaders = (token: string): Record<string, string> => ({
  [PREVIEW_TOKEN_HEADER]: token,
  [PREVIEW_SKIP_WARNING_HEADER]: "true",
});

const wakingInFlight = new Map<string, Promise<void>>();

function send(res: ServerResponse, status: number, body: string, type: string): void {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendWaking(res: ServerResponse): void {
  res.writeHead(503, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "retry-after": "3",
  });
  res.end(wakingPage());
}

function previewOrigin(url: string): string {
  return new URL(url).origin;
}

export function startProxy(
  port = PROXY_PORT,
  store: CachedStore = createStore(),
): Promise<http.Server> {
  const daytona = createDaytonaClient();
  const proxy = httpProxy.createProxyServer({
    changeOrigin: true,
    ws: true,
    secure: true,
    xfwd: true,
  });

  proxy.on("error", (error, _req, res) => {
    const message = error instanceof Error ? error.message : "proxy error";
    if (res && "writeHead" in res && !res.headersSent) {
      send(res, 502, `Upstream preview error: ${message}`, "text/plain; charset=utf-8");
      return;
    }
    if (res && "destroy" in res) {
      res.destroy();
    }
  });

  async function resolveRoute(req: IncomingMessage): Promise<
    | { ok: true; route: DeploymentRoute }
    | { ok: false; status: number; html: string; waking?: boolean }
  > {
    const slug = slugFromHost(req.headers.host);
    if (!slug) {
      return { ok: false, status: 200, html: statusPage(await store.list()) };
    }

    const route = await store.getBySlug(slug);
    if (!route) {
      return {
        ok: false,
        status: 404,
        html: unknownSlugPage(slug, await store.list()),
      };
    }

    let sandbox: Sandbox;
    try {
      sandbox = await daytona.get(route.sandboxId);
    } catch (error) {
      if (error instanceof DaytonaError) {
        return {
          ok: false,
          status: 502,
          html: messagePage("Sandbox lookup failed", error.message),
        };
      }
      throw error;
    }

    await sandbox.refreshData();
    const state = sandbox.state;

    if (state === SandboxState.DESTROYED || state === SandboxState.DESTROYING) {
      return {
        ok: false,
        status: 410,
        html: messagePage("Sandbox gone", "This deployment's sandbox was deleted."),
      };
    }

    if (state === SandboxState.ERROR || state === SandboxState.BUILD_FAILED) {
      return {
        ok: false,
        status: 502,
        html: messagePage("Sandbox error", sandbox.errorReason ?? "Sandbox is in an error state"),
      };
    }

    if (state !== SandboxState.STARTED) {
      const key = route.sandboxId;
      if (!wakingInFlight.has(key)) {
        const wake = wakeSandboxForPreview(sandbox, route.port)
          .then(async (preview) => {
            await store.updatePreview(route.id, preview.url, preview.token);
          })
          .catch((error) => {
            console.error(`Wake failed for ${slug}:`, error);
          })
          .finally(() => {
            wakingInFlight.delete(key);
          });
        wakingInFlight.set(key, wake);
      }
      return { ok: false, status: 503, html: "", waking: true };
    }

    return { ok: true, route };
  }

  const server = http.createServer((req, res) => {
    void resolveRoute(req)
      .then((resolved) => {
        const host = req.headers.host ?? "";
        if (!resolved.ok) {
          console.log(`${req.method} ${host}${req.url ?? "/"} → ${resolved.waking ? 503 : resolved.status}`);
          if (resolved.waking) {
            sendWaking(res);
            return;
          }
          send(res, resolved.status, resolved.html, "text/html; charset=utf-8");
          return;
        }

        console.log(`${req.method} ${host}${req.url ?? "/"} → proxy ${resolved.route.slug}`);
        proxy.web(req, res, {
          target: previewOrigin(resolved.route.previewUrl),
          headers: previewHeaders(resolved.route.previewToken),
        });
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : "internal error";
        if (!res.headersSent) {
          send(res, 500, messagePage("Proxy error", message), "text/html; charset=utf-8");
        }
      });
  });

  server.on("upgrade", (req, socket, head) => {
    void resolveRoute(req)
      .then((resolved) => {
        if (!resolved.ok) {
          socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }

        proxy.ws(req, socket, head, {
          target: previewOrigin(resolved.route.previewUrl),
          headers: previewHeaders(resolved.route.previewToken),
        });
      })
      .catch(() => {
        socket.destroy();
      });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      console.log(`Hoist proxy listening on :${port} (slug.localhost)`);
      resolve(server);
    });
  });
}

const isMain =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startProxy().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
