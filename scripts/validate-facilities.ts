/** Validate data/facilities/*.json against the app's own rules. `npm run validate:facilities` */
import { loadFacilityFiles, validateFacilities } from "../src/lib/facilities";

const list = loadFacilityFiles();
const { issues, duplicateResources } = validateFacilities(list);
const resources = list.reduce((a, f) => a + f.resources.length, 0);
const byConf: Record<string, number> = {};
for (const f of list) byConf[f.geocodeConfidence] = (byConf[f.geocodeConfidence] ?? 0) + 1;
console.log(`facilities=${list.length} resources=${resources} duplicates=${duplicateResources.length}`, byConf);
for (const i of issues) console.log(`[${i.level}] ${i.facilityId ?? ""}: ${i.message}`);
process.exit(issues.some((i) => i.level === "error") ? 1 : 0);
