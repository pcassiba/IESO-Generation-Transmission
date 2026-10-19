export async function register() {
  // On Vercel there is no long-running process: polling happens per request instead (see src/lib/server.ts pollServerless).
  if (process.env.NEXT_RUNTIME === "nodejs" && !process.env.VERCEL) {
    const { startScheduler } = await import("./lib/server");
    startScheduler();
  }
}
