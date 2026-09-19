import { ensureGpuBackend } from "../lib/nosana.js";

async function main(): Promise<void> {
  console.log("GPU: warming");
  const backend = await ensureGpuBackend({
    onStatus: (status, detail) => console.log(`GPU: ${status} — ${detail}`),
  });
  console.log(`GPU: ${backend.status}`);
  console.log(`URL: ${backend.url}`);
  console.log(`Host: ${backend.host}`);
  console.log(`Deployment: ${backend.deploymentId} (${backend.deploymentStatus ?? "unqueried"})`);
  console.log(`Source: ${backend.source} started=${backend.started}`);
  console.log(`Health: HTTP ${backend.health.status} ${backend.health.detail}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
