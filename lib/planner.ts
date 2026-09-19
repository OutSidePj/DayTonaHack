import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

export const PlanSchema = z.object({
  runtime: z.enum(["vite", "next", "static", "node"]),
  package_manager: z.enum(["pnpm", "npm", "yarn"]),
  install: z.string(),
  build: z.string(),
  start: z.string(),
  port: z.number().int().positive(),
  static_dir: z.string().optional(),
  env_required: z.array(z.string()),
  needs_db: z.boolean(),
  risk_flags: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

export type Plan = z.infer<typeof PlanSchema>;

export type Manifests = {
  fileList: string[];
  files: Record<string, string>;
};

export class DeployBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployBlockedError";
  }
}

const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929";

const DB_PACKAGES = [
  "prisma",
  "@prisma/client",
  "drizzle-orm",
  "mongoose",
  "sequelize",
  "typeorm",
  "knex",
  "pg",
  "postgres",
  "mysql",
  "mysql2",
  "mongodb",
  "sqlite3",
  "better-sqlite3",
  "redis",
  "ioredis",
];

const DB_ENV = ["DATABASE_URL", "POSTGRES_URL", "MYSQL_URL", "MONGO_URL", "REDIS_URL"];

const SECRET_HINTS = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "MYSQL_URL",
  "MONGO_URL",
  "REDIS_URL",
  "SECRET",
  "API_KEY",
  "PRIVATE_KEY",
  "AUTH_SECRET",
  "NEXTAUTH_SECRET",
];

function packageManagerFromFiles(names: string[]): Plan["package_manager"] {
  if (names.includes("pnpm-lock.yaml")) return "pnpm";
  if (names.includes("yarn.lock")) return "yarn";
  if (names.includes("package-lock.json")) return "npm";
  return "pnpm";
}

function pmExec(pm: Plan["package_manager"]): string {
  if (pm === "pnpm") return "npx --yes pnpm@10.15.1";
  if (pm === "yarn") return "npx --yes yarn@1";
  return "npm";
}

function installCommand(pm: Plan["package_manager"]): string {
  if (pm === "pnpm") return `${pmExec(pm)} install --frozen-lockfile=false`;
  if (pm === "yarn") return `${pmExec(pm)} install`;
  return "npm install";
}

function packageJsonRel(manifests: Manifests): string | undefined {
  return manifests.fileList.find((path) => path === "package.json" || path.endsWith("/package.json"));
}

function appDir(manifests: Manifests): string {
  const pkg = packageJsonRel(manifests);
  if (!pkg || pkg === "package.json") return "";
  return pkg.replace(/\/package\.json$/, "");
}

function withDir(dir: string, command: string): string {
  return dir ? `cd ${dir} && ${command}` : command;
}

function requirementsRel(manifests: Manifests): string | undefined {
  return manifests.fileList.find((path) => path === "requirements.txt" || path.endsWith("/requirements.txt"));
}

function fastapiRoot(manifests: Manifests): string | undefined {
  const req = requirementsRel(manifests);
  if (!req) return undefined;
  const body = manifests.files["requirements.txt"] ?? "";
  if (body && !/fastapi/i.test(body)) return undefined;
  if (req === "requirements.txt") return ".";
  return req.replace(/\/requirements\.txt$/, "");
}

function parsePackageJson(raw: string | undefined): {
  scripts: Record<string, string>;
  deps: string[];
} {
  if (!raw) return { scripts: {}, deps: [] };
  try {
    const parsed = JSON.parse(raw) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return {
      scripts: parsed.scripts ?? {},
      deps: [
        ...Object.keys(parsed.dependencies ?? {}),
        ...Object.keys(parsed.devDependencies ?? {}),
      ],
    };
  } catch {
    return { scripts: {}, deps: [] };
  }
}

function detectRuntime(
  names: string[],
  deps: string[],
  scripts: Record<string, string>,
): Plan["runtime"] {
  if (deps.includes("next") || names.some((n) => n.startsWith("next.config."))) {
    return "next";
  }
  if (deps.includes("vite") || names.some((n) => n.startsWith("vite.config."))) {
    return "vite";
  }
  if (scripts.build && /vite|react-scripts/.test(scripts.build)) return "vite";
  return "node";
}

function envRequiredFromManifests(manifests: Manifests): string[] {
  const required = new Set<string>();
  const example = manifests.files[".env.example"] ?? manifests.files[".env.sample"] ?? "";
  for (const line of example.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const key = trimmed.split("=", 1)[0]?.trim();
    if (key && SECRET_HINTS.some((hint) => key.toUpperCase().includes(hint))) {
      required.add(key);
    }
  }
  return [...required];
}

function needsDb(manifests: Manifests, deps: string[]): boolean {
  if (deps.some((dep) => DB_PACKAGES.includes(dep))) {
    return true;
  }
  const example = `${manifests.files[".env.example"] ?? ""}\n${manifests.files[".env.sample"] ?? ""}`;
  return DB_ENV.some((key) => example.includes(key));
}

function riskFlags(manifests: Manifests, scripts: Record<string, string>): string[] {
  const flags: string[] = [];
  if (manifests.files.Dockerfile) flags.push("dockerfile");
  if (manifests.fileList.some((n) => n.includes("docker-compose"))) flags.push("docker-compose");
  if (manifests.files.Procfile) flags.push("procfile");
  if (Object.values(scripts).some((s) => /\beval\b/.test(s))) flags.push("eval-script");
  return flags;
}

export function heuristicPlan(manifests: Manifests): Plan {
  const names = manifests.fileList.map((p) => p.split("/").pop() ?? p);
  const pm = packageManagerFromFiles(names);
  const exec = pmExec(pm);
  const { scripts, deps } = parsePackageJson(manifests.files["package.json"]);
  const runtime = detectRuntime(names, deps, scripts);
  const env_required = envRequiredFromManifests(manifests);
  const db = needsDb(manifests, deps);
  const risk_flags = riskFlags(manifests, scripts);

  const dir = appDir(manifests);
  const apiRoot = fastapiRoot(manifests);
  if (apiRoot) {
    risk_flags.push("fastapi");
  }

  if (runtime === "vite" && scripts.build) {
    const staticDir = dir ? `${dir}/dist` : "dist";
    const install = apiRoot
      ? `( ${withDir(dir, installCommand(pm))} ) && python3 -m pip install fastapi 'uvicorn[standard]' httpx pydantic`
      : withDir(dir, installCommand(pm));
    const start = apiRoot
      ? `MOCK_INFERENCE=true python3 -m uvicorn app.main:app --app-dir ${apiRoot} --host 127.0.0.1 --port 8000 & npx --yes -- http-server@14 ${staticDir} -a 0.0.0.0 -p 4173 -P http://127.0.0.1:8000`
      : `npx --yes serve@14 -s ${staticDir} --listen tcp://0.0.0.0:4173`;
    return {
      runtime,
      package_manager: pm,
      install,
      build: withDir(dir, `${exec} run build`),
      start,
      port: 4173,
      static_dir: staticDir,
      env_required,
      needs_db: db,
      risk_flags,
      confidence: dir || apiRoot ? 0.8 : 0.9,
    };
  }

  if (runtime === "next") {
    return {
      runtime,
      package_manager: pm,
      install: installCommand(pm),
      build: `${exec} run build`,
      start: `${exec} run start -- --hostname 0.0.0.0 --port 3000`,
      port: 3000,
      env_required,
      needs_db: db,
      risk_flags,
      confidence: scripts.build ? 0.85 : 0.6,
    };
  }

  if (scripts.build && (scripts.preview || scripts.start)) {
    const start = scripts.preview
      ? `${exec} run preview -- --host 0.0.0.0 --port 4173`
      : `${exec} run start`;
    return {
      runtime: "node",
      package_manager: pm,
      install: installCommand(pm),
      build: `${exec} run build`,
      start,
      port: 4173,
      env_required,
      needs_db: db,
      risk_flags,
      confidence: 0.55,
    };
  }

  return {
    runtime: "node",
    package_manager: pm,
    install: installCommand(pm),
    build: scripts.build ? `${exec} run build` : "true",
    start: scripts.start ? `${exec} run start` : "npx --yes serve@14 -s . --listen tcp://0.0.0.0:4173",
    port: 4173,
    env_required,
    needs_db: db,
    risk_flags,
    confidence: manifests.files["package.json"] ? 0.4 : 0.2,
  };
}

function requireAnthropicKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  return key;
}

async function askClaude(prompt: string): Promise<Plan> {
  const client = new Anthropic({ apiKey: requireAnthropicKey() });
  const message = await client.messages.parse({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
    output_config: { format: zodOutputFormat(PlanSchema) },
  });
  if (!message.parsed_output) {
    throw new Error("Claude did not return a valid plan");
  }
  return message.parsed_output;
}

export async function claudePlan(manifests: Manifests, previous?: Plan): Promise<Plan> {
  const files = Object.entries(manifests.files)
    .map(([name, body]) => `--- ${name} ---\n${body.slice(0, 4000)}`)
    .join("\n\n");
  return askClaude(
    `Plan how to install, build, and serve this untrusted web app in a locked-down sandbox.
Prefer a production build + static serve for SPAs. Dev servers must bind 0.0.0.0.
Do not invent secrets. If a database or required env vars are needed, set needs_db / env_required.
${previous ? `Previous heuristic plan: ${JSON.stringify(previous)}` : ""}
File list: ${manifests.fileList.join(", ")}

${files}`,
  );
}

export async function repairPlan(plan: Plan, logs: string): Promise<Plan> {
  return askClaude(
    `The previous build plan failed. Return a repaired plan with the same schema.
Prefer static serve for SPAs. Bind 0.0.0.0. Do not invent secrets.

Failed plan:
${JSON.stringify(plan, null, 2)}

Logs:
${logs.slice(0, 8000)}`,
  );
}

export async function decidePlan(manifests: Manifests): Promise<Plan> {
  const heuristic = heuristicPlan(manifests);
  if (heuristic.confidence >= 0.75) {
    return heuristic;
  }
  return claudePlan(manifests, heuristic);
}

export function assertDeployable(plan: Plan): void {
  if (plan.needs_db) {
    throw new DeployBlockedError(
      "This repo looks like it needs a database. Hoist will not deploy a broken site.",
    );
  }
  if (plan.env_required.length > 0) {
    throw new DeployBlockedError(
      `This repo requires secrets we will not inject: ${plan.env_required.join(", ")}`,
    );
  }
}
