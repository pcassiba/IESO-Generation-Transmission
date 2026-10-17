// Copies MapLibre's ES-module web worker into /public so it can be served at /maplibre-gl-worker.mjs.
// (Webpack does not bundle MapLibre v6's `new URL("./maplibre-gl-worker.mjs", import.meta.url)` worker.)
const fs = require("fs");
const path = require("path");
const src = path.join(__dirname, "..", "node_modules", "maplibre-gl", "dist", "maplibre-gl-worker.mjs");
const dst = path.join(__dirname, "..", "public", "maplibre-gl-worker.mjs");
fs.copyFileSync(src, dst);
console.log("Copied MapLibre worker to public/");
