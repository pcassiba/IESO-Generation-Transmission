// GeoJSON files are imported as parsed JSON (webpack rule in next.config.ts); used by src/lib/bundled-files.ts.
declare module "*.geojson" {
  const value: unknown;
  export default value;
}
