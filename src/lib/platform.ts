/**
 * Where the server code is running. The same code serves three hosts:
 *  - a long-running Node.js server (`npm run dev` / `npm start`), which polls IESO on a timer;
 *  - Vercel serverless functions (VERCEL is set), which poll per request plus a daily cron;
 *  - Cloudflare Workers via OpenNext (see wrangler.jsonc), which poll per request plus a Cron Trigger.
 */

/** True inside the Cloudflare Workers runtime (workerd), including `opennextjs-cloudflare preview`. */
export function isCloudflareWorkers(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
}

/** True on hosts with no long-running process, where timers cannot drive polling. */
export function isServerless(): boolean {
  return Boolean(process.env.VERCEL) || isCloudflareWorkers();
}
