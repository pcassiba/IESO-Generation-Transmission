/**
 * Copies of the project's data files, compiled into the Cloudflare Worker (which cannot read the
 * project directory at run time). Only loaded on Cloudflare; see src/lib/project-files.ts.
 *
 * When you add a JSON file under data/facilities/ or data/transmission/, add it here too
 * (tests/bundled-files.test.ts fails until you do).
 */
import hydro from "../../data/facilities/hydro.json";
import nuclearGas from "../../data/facilities/nuclear_gas.json";
import solarBioStorage from "../../data/facilities/solar_bio_storage.json";
import wind from "../../data/facilities/wind.json";
import interfaces from "../../data/transmission/interfaces.json";
import intertieLocations from "../../data/transmission/intertie-locations.json";
import pricingLocations from "../../data/transmission/pricing-locations.json";
import stationAliases from "../../data/transmission/station-aliases.json";
import substations from "../../public/geo/substations.geojson";
import transmission from "../../public/geo/transmission.geojson";

export const BUNDLED_FILES: Record<string, unknown> = {
  "data/facilities/hydro.json": hydro,
  "data/facilities/nuclear_gas.json": nuclearGas,
  "data/facilities/solar_bio_storage.json": solarBioStorage,
  "data/facilities/wind.json": wind,
  "data/transmission/interfaces.json": interfaces,
  "data/transmission/intertie-locations.json": intertieLocations,
  "data/transmission/pricing-locations.json": pricingLocations,
  "data/transmission/station-aliases.json": stationAliases,
  "public/geo/substations.geojson": substations,
  "public/geo/transmission.geojson": transmission,
};
