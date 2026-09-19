import type { DeploymentRoute } from "./lookup.js";

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: dark; }
      html, body { height: 100%; margin: 0; }
      body {
        font-family: ui-sans-serif, system-ui, sans-serif;
        background: #0b1220;
        color: #e8eefc;
        display: grid;
        place-items: center;
        padding: 24px;
      }
      main {
        width: min(640px, 100%);
        border: 1px solid #243049;
        border-radius: 16px;
        padding: 28px;
        background: #121a2b;
      }
      h1 { margin: 0 0 12px; font-size: 1.4rem; }
      p, li { color: #c3cee3; line-height: 1.5; }
      code, a { color: #8bdcff; }
      ul { padding-left: 1.2rem; }
    </style>
  </head>
  <body>
    <main>${body}</main>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function routeList(routes: DeploymentRoute[]): string {
  if (routes.length === 0) {
    return `<p>No live deployments are registered with this proxy yet.</p>
      <p>Run <code>pnpm demo:proxy</code> in another terminal. It will start a sandbox and print a real URL like <code>http://demo-vite.localhost:8080</code>.</p>`;
  }

  const items = routes
    .map((route) => {
      const href = `http://${escapeHtml(route.slug)}.localhost:8080`;
      return `<li><a href="${href}">${href}</a> — ${escapeHtml(route.status)}</li>`;
    })
    .join("");
  return `<p>Open one of these:</p><ul>${items}</ul>`;
}

export function statusPage(routes: DeploymentRoute[]): string {
  return layout(
    "Hoist proxy",
    `<h1>Hoist proxy</h1>
     <p>This host has no deployment slug. Use <code>http://&lt;slug&gt;.localhost:8080</code> after a deploy — not the placeholder with angle brackets.</p>
     ${routeList(routes)}`,
  );
}

export function unknownSlugPage(slug: string, routes: DeploymentRoute[]): string {
  return layout(
    `No deployment for ${slug}`,
    `<h1>No deployment for <code>${escapeHtml(slug)}</code></h1>
     ${routeList(routes)}`,
  );
}

export function messagePage(title: string, message: string): string {
  return layout(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}
