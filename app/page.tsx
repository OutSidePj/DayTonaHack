"use client";

import { useEffect, useMemo, useState } from "react";

const STAGES = ["scouting", "planning", "building", "locking", "routing", "live"] as const;

type Stage = (typeof STAGES)[number] | "queued" | "failed";

type Deployment = {
  id: string;
  repo_url: string;
  commit_sha: string | null;
  slug: string;
  status: Stage;
  public_url: string | null;
  dns_name: string | null;
  lockdown: { state: string; detail: string } | null;
  egress: { target: string; result: string; detail: string } | null;
  plan: { risk_flags?: string[]; runtime?: string } | null;
  gpu: boolean;
  gpu_status: "warming" | "ready" | null;
  gpu_url: string | null;
  expires_at: string | null;
  error: string | null;
  events: { stage: string; message: string; at: string }[];
};

const DEFAULT_REPO = "https://github.com/criesbeck/react-ts-vitest";

function stageIndex(status: string): number {
  const idx = STAGES.indexOf(status as (typeof STAGES)[number]);
  return idx;
}

function formatTtl(expiresAt: string | null, now: number): string {
  if (!expiresAt) return "—";
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return "expired";
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export default function Page() {
  const [repoUrl, setRepoUrl] = useState(DEFAULT_REPO);
  const [gpu, setGpu] = useState(false);
  const [id, setId] = useState<string | null>(null);
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const fromQuery = new URLSearchParams(window.location.search).get("id");
    const fromSession = window.sessionStorage.getItem("hoist:last-deploy");
    const restored = fromQuery ?? fromSession;
    if (restored) setId(restored);
  }, []);

  useEffect(() => {
    if (!id) return;
    let closed = false;
    void fetch(`/api/deployments/${id}`)
      .then((res) => res.json())
      .then((data: Deployment & { error?: string }) => {
        if (!data.error) setDeployment(data);
        if (data.status === "live" || data.status === "failed") {
          setBusy(false);
        }
      });
    const source = new EventSource(`/api/deployments/${id}/events`);
    source.onmessage = (message) => {
      const payload = JSON.parse(message.data) as {
        type: string;
        deployment?: Deployment;
        stage?: string;
        message?: string;
        status?: Stage;
      };
      if (payload.deployment) {
        setDeployment(payload.deployment);
      }
      if (payload.type === "done") {
        closed = true;
        source.close();
        setBusy(false);
      }
    };
    source.onerror = () => {
      if (closed) {
        source.close();
        return;
      }
      void fetch(`/api/deployments/${id}`)
        .then((res) => res.json())
        .then((data: Deployment & { error?: string }) => {
          if (data.error) return;
          setDeployment(data);
          if (data.status === "live" || data.status === "failed") {
            closed = true;
            source.close();
            setBusy(false);
          }
        });
    };
    return () => {
      closed = true;
      source.close();
    };
  }, [id]);

  async function deploy(): Promise<void> {
    setBusy(true);
    setError(null);
    setDeployment(null);
    const response = await fetch("/api/deploy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoUrl, gpu }),
    });
    const body = (await response.json()) as { id?: string; error?: string };
    if (!response.ok || !body.id) {
      setBusy(false);
      setError(body.error ?? "Deploy failed");
      return;
    }
    window.sessionStorage.setItem("hoist:last-deploy", body.id);
    setId(body.id);
  }

  const current = deployment?.status ?? "queued";
  const liveUrl = deployment?.public_url;
  const activeIndex = stageIndex(current);

  const riskFlags = useMemo(() => deployment?.plan?.risk_flags ?? [], [deployment]);

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-10 px-6 py-10">
      <header className="flex items-end justify-between gap-6 border-b border-line pb-6">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-hook">Daytona · DNSimple · Nosana</p>
          <h1 className="mt-2 font-display text-6xl leading-none text-paper">Repo2Ready</h1>
          <p className="mt-3 max-w-xl text-sm text-mute">
            Paste a GitHub URL. We scout it, lock it in a Daytona sandbox, stamp a DNSimple name, and
            hand you a live preview. GPU is optional.
          </p>
        </div>
        <p className="hidden font-mono text-xs text-mute sm:block">45 min TTL</p>
      </header>

      <section className="grid gap-4 rounded-sm border border-line bg-panel p-5">
        <label className="font-mono text-[11px] uppercase tracking-[0.2em] text-mute" htmlFor="repo">
          GitHub URL
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            id="repo"
            value={repoUrl}
            onChange={(event) => setRepoUrl(event.target.value)}
            className="min-w-0 flex-1 border border-line bg-ink px-3 py-3 font-mono text-sm text-paper outline-none focus:border-hook"
            placeholder={DEFAULT_REPO}
            spellCheck={false}
          />
          <button
            type="button"
            onClick={() => void deploy()}
            disabled={busy}
            className="bg-hook px-5 py-3 font-mono text-sm font-medium text-ink disabled:opacity-50"
          >
            {busy ? "Hoisting…" : "Deploy"}
          </button>
        </div>
        <label className="flex items-center gap-3 font-mono text-sm text-paper">
          <input
            type="checkbox"
            checked={gpu}
            onChange={(event) => setGpu(event.target.checked)}
            className="size-4 accent-hook"
          />
          Attach GPU backend
          <span className="text-mute">MiniMax ComfyUI on Nosana</span>
        </label>
        {error ? <p className="font-mono text-sm text-danger">{error}</p> : null}
      </section>

      <section className="grid gap-8 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-sm border border-line bg-panel p-5">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.2em] text-mute">Stages</h2>
          <ol className="mt-4 space-y-3">
            {STAGES.map((stage, index) => {
              const done = current === "live" || (activeIndex !== -1 && index < activeIndex);
              const active = current === stage;
              const failed = current === "failed" && index === Math.max(activeIndex, 0);
              return (
                <li key={stage} className="flex items-center gap-3 font-mono text-sm">
                  <span
                    className={`size-2 rounded-full ${
                      failed ? "bg-danger" : active ? "bg-hook" : done ? "bg-ok" : "bg-line"
                    }`}
                  />
                  <span className={active || done ? "text-paper" : "text-mute"}>{stage}</span>
                </li>
              );
            })}
          </ol>
          <ul className="mt-6 space-y-2 border-t border-line pt-4 font-mono text-xs text-mute">
            {(deployment?.events ?? []).map((event, index) => (
              <li key={`${index}-${event.at}`}>
                <span className="text-hook">{event.stage}</span> {event.message}
              </li>
            ))}
          </ul>
          {deployment?.error ? (
            <p className="mt-4 font-mono text-sm text-danger">{deployment.error}</p>
          ) : null}
        </div>

        <aside className="rounded-sm border border-line bg-panel p-5">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.2em] text-mute">Security</h2>
          <dl className="mt-4 space-y-3 font-mono text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-mute">Lockdown</dt>
              <dd>{deployment?.lockdown?.state ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-mute">Egress</dt>
              <dd>
                {deployment?.egress
                  ? `${deployment.egress.result} ${deployment.egress.target.replace("https://", "")}`
                  : "—"}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-mute">TTL</dt>
              <dd>{formatTtl(deployment?.expires_at ?? null, now)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-mute">Risk flags</dt>
              <dd>{riskFlags.length ? riskFlags.join(", ") : "none"}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-mute">GPU</dt>
              <dd>
                {deployment?.gpu
                  ? `GPU: ${deployment.gpu_status ?? "warming"}`
                  : "off"}
              </dd>
            </div>
          </dl>
          {deployment?.lockdown?.detail ? (
            <p className="mt-4 font-mono text-[11px] leading-5 text-mute">{deployment.lockdown.detail}</p>
          ) : null}
        </aside>
      </section>

      {current === "live" && liveUrl ? (
        <section className="rounded-sm border border-line bg-panel p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-3xl">Live</h2>
            <a
              href={liveUrl}
              target="_blank"
              rel="noreferrer"
              className="bg-hook px-4 py-2 font-mono text-sm text-ink"
            >
              Open live site
            </a>
          </div>
          <p className="mt-2 font-mono text-xs text-mute">
            {liveUrl}
            {deployment?.dns_name ? ` · ${deployment.dns_name}` : ""}
          </p>
          <iframe
            title="Live preview"
            src={liveUrl}
            className="mt-4 h-[480px] w-full border border-line bg-ink"
          />
        </section>
      ) : null}
    </main>
  );
}
