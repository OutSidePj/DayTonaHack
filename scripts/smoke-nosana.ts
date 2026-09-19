import {
  checkEgress,
  createDaytonaClient,
  createRunSandbox,
  deleteSandbox,
} from "../lib/daytona.js";
import {
  GPU_ENV_NAME,
  attachGpuToSandbox,
  ensureGpuBackend,
} from "../lib/nosana.js";

async function main(): Promise<void> {
  console.log("GPU: warming");
  const backend = await ensureGpuBackend({
    onStatus: (status, detail) => console.log(`GPU: ${status} — ${detail}`),
  });
  console.log(`GPU: ${backend.status}`);
  console.log(`URL: ${backend.url}`);
  console.log(`Deployment: ${backend.deploymentId} source=${backend.source}`);

  const daytona = createDaytonaClient();
  const run = await createRunSandbox(daytona);
  try {
    console.log(`Run: ${run.id}`);
    const lockdown = await attachGpuToSandbox(run, backend);
    console.log(`Lockdown: ${lockdown.state} (${lockdown.detail})`);

    const env = await run.process.executeCommand(`printenv ${GPU_ENV_NAME}`, undefined, undefined, 15);
    const injected = env.result.trim();
    if (env.exitCode !== 0 || injected !== backend.url) {
      throw new Error(
        `${GPU_ENV_NAME} was '${injected}' (exit ${env.exitCode ?? "unknown"}), expected ${backend.url}`,
      );
    }
    console.log(`${GPU_ENV_NAME}=${injected}`);

    const fromSandbox = await run.process.executeCommand(
      `curl -m 15 -sS -o /tmp/comfy.json -w '%{http_code}' "$NOSANA_COMFY_URL/system_stats" || true`,
      undefined,
      undefined,
      30,
    );
    const code = fromSandbox.result.trim();
    const gpuAllowed = /^(200)$/.test(code);
    console.log(
      `Sandbox → ComfyUI /system_stats: ${gpuAllowed ? "allowed" : "blocked"} (${code || fromSandbox.exitCode})`,
    );

    const egress = await checkEgress(run);
    console.log(`Egress ${egress.target}: ${egress.result} (${egress.detail})`);
    console.log("Stage 5 smoke test passed.");
  } finally {
    await deleteSandbox(run);
    console.log("Sandbox deleted.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
