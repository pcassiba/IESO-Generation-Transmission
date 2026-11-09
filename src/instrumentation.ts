export async function register() {
  // Serverless hosts have no long-running process: polling happens per request instead (see src/lib/server.ts
  // pollServerless) plus a scheduled call to /api/cron (vercel.json on Vercel, a Cron Trigger on Cloudflare).
  if (process.env.NEXT_RUNTIME === "nodejs" && !process.env.VERCEL) {
    const { isCloudflareWorkers } = await import("./lib/platform");
    if (isCloudflareWorkers()) return;
    const { startScheduler } = await import("./lib/server");
    startScheduler();
  }
}
