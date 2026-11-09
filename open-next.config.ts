// OpenNext adapter settings for Cloudflare Workers (https://opennext.js.org/cloudflare).
// Every API route is dynamic and data lives in Postgres, so no incremental (ISR) cache is configured.
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({});
