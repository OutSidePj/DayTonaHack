"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type AppState = "idle" | "running" | "success";

const STEPS = [
  "Creating isolated sandbox",
  "Cloning repository",
  "Analyzing project",
  "Installing dependencies",
  "Starting application",
  "Generating live preview",
] as const;

const TERMINAL_LINES = [
  { command: "Creating Daytona sandbox...", success: "Sandbox ready" },
  { command: "git clone repository", success: "Repository cloned" },
  { command: "Detecting framework...", success: "Next.js detected" },
  { command: "npm install", success: "Dependencies installed" },
  { command: "npm run dev", success: "Server running on port 3000" },
] as const;

const FLOW = [
  { label: "GitHub URL", icon: "github" },
  { label: "Secure Sandbox", icon: "sandbox" },
  { label: "Automatic Setup", icon: "setup" },
  { label: "Running App", icon: "app" },
  { label: "Live Preview", icon: "preview" },
] as const;

const STEP_DELAY_MS = 900;
const TERMINAL_DELAY_MS = 700;

// TODO: Replace with previewUrl from backend API response when Daytona integration is ready.
const PLACEHOLDER_PREVIEW_URL = "https://example.com/preview";

function Spinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin text-accent"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      className="h-4 w-4 text-emerald-600"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function FlowArrow() {
  return (
    <svg
      className="hidden h-4 w-4 shrink-0 text-neutral-300 sm:block"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export default function Home() {
  const [repoUrl, setRepoUrl] = useState("");
  const [error, setError] = useState("");
  const [appState, setAppState] = useState<AppState>("idle");
  const [currentStep, setCurrentStep] = useState(0);
  const [terminalLines, setTerminalLines] = useState<
    Array<{ command: string; success?: string; pending?: boolean }>
  >([]);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  }, []);

  const reset = useCallback(() => {
    clearTimers();
    setRepoUrl("");
    setError("");
    setAppState("idle");
    setCurrentStep(0);
    setTerminalLines([]);
  }, [clearTimers]);

  const schedule = useCallback((fn: () => void, delay: number) => {
    const id = setTimeout(fn, delay);
    timersRef.current.push(id);
  }, []);

  const runPreview = useCallback(() => {
    if (!repoUrl.trim()) {
      setError("Please enter a GitHub repository URL.");
      return;
    }

    clearTimers();
    setError("");
    setAppState("running");
    setCurrentStep(0);
    setTerminalLines([]);

    let elapsed = 0;

    STEPS.forEach((_, index) => {
      schedule(() => setCurrentStep(index), elapsed);
      elapsed += STEP_DELAY_MS;
    });

    let terminalElapsed = 400;
    TERMINAL_LINES.forEach((line) => {
      schedule(() => {
        setTerminalLines((prev) => [
          ...prev.filter((l) => !l.pending),
          { command: line.command, pending: true },
        ]);
      }, terminalElapsed);

      terminalElapsed += TERMINAL_DELAY_MS;

      schedule(() => {
        setTerminalLines((prev) => [
          ...prev.slice(0, -1),
          { command: line.command, success: line.success },
        ]);
      }, terminalElapsed);

      terminalElapsed += TERMINAL_DELAY_MS;
    });

    schedule(() => {
      setCurrentStep(STEPS.length);
      setAppState("success");
    }, elapsed);
  }, [repoUrl, clearTimers, schedule]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const isRunning = appState === "running";
  const isSuccess = appState === "success";
  const showProgress = isRunning || isSuccess;

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-border bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-neutral-900 text-sm font-bold text-white">
              R2
            </div>
            <span className="text-lg font-semibold tracking-tight text-neutral-900">
              Repo2Ready
            </span>
          </div>
          <span className="rounded-full border border-border bg-neutral-50 px-3 py-1 text-xs font-medium text-muted">
            Powered by Daytona + Nosana
          </span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6 sm:py-16">
        <section className="mx-auto max-w-2xl text-center">
          <h1 className="text-3xl font-semibold tracking-tight text-neutral-900 sm:text-4xl sm:leading-tight">
            From GitHub to a live app in one click.
          </h1>
          <p className="mt-4 text-base leading-relaxed text-muted sm:text-lg">
            Paste a GitHub repository. We handle the setup and give you a live
            preview — no local environment required.
          </p>
        </section>

        <section className="mx-auto mt-10 max-w-2xl">
          <div className="flex flex-wrap items-center justify-center gap-2 sm:flex-nowrap sm:gap-1">
            {FLOW.map((step, index) => (
              <div key={step.label} className="flex items-center gap-1 sm:gap-2">
                <div
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    showProgress && index <= (isSuccess ? 4 : Math.min(currentStep, 4))
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                      : "border-border bg-white text-muted"
                  }`}
                >
                  {step.label}
                </div>
                {index < FLOW.length - 1 && <FlowArrow />}
              </div>
            ))}
          </div>
        </section>

        {appState === "idle" && (
          <section className="mx-auto mt-10 max-w-2xl">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                runPreview();
              }}
              className="rounded-xl border border-border bg-white p-2 shadow-sm"
            >
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="url"
                  value={repoUrl}
                  onChange={(e) => {
                    setRepoUrl(e.target.value);
                    if (error) setError("");
                  }}
                  placeholder="https://github.com/username/repository"
                  className="min-w-0 flex-1 rounded-lg border-0 bg-neutral-50 px-4 py-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-accent/30"
                  aria-label="GitHub repository URL"
                  aria-invalid={!!error}
                />
                <button
                  type="submit"
                  className="shrink-0 rounded-lg bg-neutral-900 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-900/30"
                >
                  Run Preview
                </button>
              </div>
            </form>
            {error && (
              <p className="mt-2 text-sm text-red-600" role="alert">
                {error}
              </p>
            )}
          </section>
        )}

        {showProgress && (
          <section className="mx-auto mt-10 max-w-2xl space-y-4">
            <div className="rounded-xl border border-border bg-white p-6 shadow-sm">
              <h2 className="text-sm font-medium text-neutral-900">
                {isSuccess ? "Deployment complete" : "Setting up your repository"}
              </h2>
              <p className="mt-1 truncate text-xs text-muted">{repoUrl}</p>

              <ol className="mt-6 space-y-3">
                {STEPS.map((step, index) => {
                  const isComplete =
                    isSuccess || (isRunning && index < currentStep);
                  const isCurrent = isRunning && index === currentStep;

                  return (
                    <li key={step} className="flex items-center gap-3 text-sm">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                        {isComplete ? (
                          <CheckIcon />
                        ) : isCurrent ? (
                          <Spinner />
                        ) : (
                          <span className="h-2 w-2 rounded-full bg-neutral-200" />
                        )}
                      </span>
                      <span
                        className={
                          isComplete || isCurrent
                            ? "text-neutral-900"
                            : "text-neutral-400"
                        }
                      >
                        {step}
                      </span>
                    </li>
                  );
                })}
              </ol>

              {terminalLines.length > 0 && (
                <div className="mt-6 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950">
                  <div className="border-b border-neutral-800 px-3 py-2">
                    <span className="font-mono text-xs text-neutral-500">
                      terminal
                    </span>
                  </div>
                  <div className="space-y-1 p-4 font-mono text-xs leading-relaxed">
                    {terminalLines.map((line, index) => (
                      <div key={`${line.command}-${index}`}>
                        <div className="flex items-start gap-2 text-neutral-300">
                          <span className="text-emerald-500">$</span>
                          <span>{line.command}</span>
                          {line.pending && (
                            <span className="ml-1 inline-block h-3 w-1 animate-pulse bg-neutral-500" />
                          )}
                        </div>
                        {line.success && (
                          <div className="ml-4 text-emerald-400">
                            ✓ {line.success}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {isSuccess && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-6 shadow-sm">
                <h2 className="text-xl font-semibold text-neutral-900">
                  Your app is ready!
                </h2>

                <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
                  <div>
                    <dt className="text-muted">Framework</dt>
                    <dd className="mt-0.5 font-medium text-neutral-900">
                      Next.js
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Runtime</dt>
                    <dd className="mt-0.5 font-medium text-neutral-900">
                      Node.js
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Port</dt>
                    <dd className="mt-0.5 font-medium text-neutral-900">
                      3000
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Status</dt>
                    <dd className="mt-0.5 font-medium text-emerald-700">
                      Running
                    </dd>
                  </div>
                </dl>

                <p className="mt-4 text-sm text-muted">
                  Running securely in a Daytona Sandbox
                </p>

                <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                  <a
                    href={PLACEHOLDER_PREVIEW_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-neutral-900 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-neutral-800"
                  >
                    Open Live Preview ↗
                  </a>
                  <button
                    type="button"
                    onClick={reset}
                    className="inline-flex items-center justify-center rounded-lg border border-border bg-white px-6 py-3 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-50"
                  >
                    Try another repository
                  </button>
                </div>
              </div>
            )}
          </section>
        )}
      </main>

      <footer className="border-t border-border bg-white py-6">
        <p className="text-center text-xs text-muted">
          GitHub URL → Secure Sandbox → Automatic Setup → Running App → Live
          Preview
        </p>
      </footer>
    </div>
  );
}
