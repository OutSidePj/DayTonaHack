import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function hoistRoot(): string {
  if (process.env.HOIST_ROOT) {
    return process.env.HOIST_ROOT;
  }

  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function hoistDir(): string {
  return resolve(hoistRoot(), ".hoist");
}

export function routesPath(): string {
  return resolve(hoistDir(), "routes.json");
}

export function deploymentsPath(): string {
  return resolve(hoistDir(), "deployments.json");
}
