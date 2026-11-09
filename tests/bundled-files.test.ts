import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLED_FILES } from "../src/lib/bundled-files";

// Cloudflare Workers read these files from the bundle, not from disk: every data file must be listed.
describe("bundled data files (Cloudflare)", () => {
  const onDisk = (dir: string, ext: string) =>
    fs.readdirSync(path.join(process.cwd(), dir)).filter((f) => f.endsWith(ext)).map((f) => `${dir}/${f}`);

  it("includes every facility and transmission JSON file and the network GeoJSON", () => {
    const expected = [...onDisk("data/facilities", ".json"), ...onDisk("data/transmission", ".json"), "public/geo/transmission.geojson", "public/geo/substations.geojson"].sort();
    expect(expected.filter((f) => !(f in BUNDLED_FILES))).toEqual([]);
  });

  it("holds the same content as the files on disk", () => {
    for (const [rel, value] of Object.entries(BUNDLED_FILES)) {
      expect(value, rel).toEqual(JSON.parse(fs.readFileSync(path.join(process.cwd(), rel), "utf8")));
    }
  });
});
