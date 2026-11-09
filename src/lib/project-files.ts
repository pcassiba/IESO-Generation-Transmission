import fs from "node:fs";
import path from "node:path";
import { isCloudflareWorkers } from "./platform";

/**
 * Reads the curated JSON files that ship with the app (data/facilities, data/transmission and
 * public/geo). On Node.js (local and Vercel) they are read from disk as before, so edits are
 * picked up without a rebuild. Cloudflare Workers have no project directory to read from, so
 * there the same files are bundled into the Worker (src/lib/bundled-files.ts) and served from
 * memory after loadBundledProjectFiles() has run.
 */

type Bundle = Record<string, unknown>;
type G = typeof globalThis & { __ogeBundledFiles?: Bundle };

const bundle = (): Bundle | undefined => (globalThis as G).__ogeBundledFiles;

/** Path relative to the project root, with forward slashes (the key used in the bundle). */
function relKey(file: string): string {
  return path.relative(process.cwd(), path.resolve(process.cwd(), file)).split(path.sep).join("/");
}

/** Load the bundled copies (Cloudflare Workers only; a no-op elsewhere). Safe to call repeatedly. */
export async function loadBundledProjectFiles(): Promise<void> {
  const g = globalThis as G;
  if (g.__ogeBundledFiles || !isCloudflareWorkers()) return;
  const { BUNDLED_FILES } = await import("./bundled-files");
  g.__ogeBundledFiles = BUNDLED_FILES;
}

/** Parsed JSON content of a project file. Throws when the file does not exist. */
export function readProjectJson<T = unknown>(file: string): T {
  const b = bundle();
  if (b) {
    const key = relKey(file);
    if (!(key in b)) throw new Error(`ENOENT: ${key} is not bundled (add it to src/lib/bundled-files.ts)`);
    return b[key] as T;
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

/** File names of the .json files in a project directory, sorted. Empty when the directory is missing. */
export function listProjectJsonFiles(dir: string): string[] {
  const b = bundle();
  if (b) {
    const prefix = relKey(dir) + "/";
    return Object.keys(b)
      .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/") && k.endsWith(".json"))
      .map((k) => k.slice(prefix.length))
      .sort();
  }
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
}

/** Changes when the file changes (modification time on disk; constant for bundled files, 0 if missing). */
export function projectFileVersion(file: string): string {
  const b = bundle();
  if (b) return relKey(file) in b ? "bundled" : "0";
  try {
    return String(fs.statSync(file).mtimeMs);
  } catch {
    return "0";
  }
}
