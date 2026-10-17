import type { OperationalStatus, StorageMode, Technology } from "./types";

export const TECH_COLOR: Record<Technology, string> = {
  gas: "#f97316",
  nuclear: "#a855f7",
  hydro: "#3b82f6",
  wind: "#14b8a6",
  solar: "#eab308",
  bioenergy: "#22c55e",
  storage: "#ec4899",
  other: "#94a3b8",
};

export const STATUS_COLOR: Record<OperationalStatus, string> = {
  generating: "#22c55e",
  available: "#3b82f6",
  derated: "#f59e0b",
  potential_oos: "#ef4444", // drawn as a hollow ring (see statusDotSvg) — distinct from confirmed
  confirmed_oos: "#dc2626",
  unknown: "#6b7280",
};

export const STORAGE_MODE_COLOR: Record<StorageMode, string> = {
  discharging: "#22c55e",
  charging: "#06b6d4",
  not_discharging: "#3b82f6",
  unavailable: "#ef4444",
  unknown: "#6b7280",
};

/** Lucide-style 24×24 glyphs (stroke-based unless noted). */
export const TECH_GLYPH: Record<Technology, string> = {
  gas: `<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>`,
  nuclear: `<g fill="currentColor" stroke="none"><circle cx="12" cy="12" r="2"/><path d="M10.2 9.1 7 3.6A9.8 9.8 0 0 0 2.2 11.4h6.4a3.5 3.5 0 0 1 1.6-2.3z"/><path d="M15.4 11.4h6.4A9.8 9.8 0 0 0 17 3.6l-3.2 5.5a3.5 3.5 0 0 1 1.6 2.3z"/><path d="M13.6 15.1a3.5 3.5 0 0 1-3.2 0l-3.2 5.5a9.8 9.8 0 0 0 9.6 0z"/></g>`,
  wind: `<path d="M12 12v10"/><path d="M9 22h6"/><g fill="currentColor" stroke="none"><path d="M12 12 11 4.2Q12 1.6 13 4.2Z"/><path d="M12 12 11 4.2Q12 1.6 13 4.2Z" transform="rotate(120 12 12)"/><path d="M12 12 11 4.2Q12 1.6 13 4.2Z" transform="rotate(240 12 12)"/><circle cx="12" cy="12" r="1.6"/></g>`,
  hydro: `<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 10.1 5 12 5 15a7 7 0 0 0 7 7z"/>`,
  solar: `<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>`,
  bioenergy: `<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>`,
  storage: `<rect width="16" height="10" x="2" y="7" rx="2" ry="2"/><path d="M22 11v2"/><path d="M6 11v2"/><path d="M10 11v2"/><path d="M14 11v2"/>`,
  other: `<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>`,
};

export function glyphSvg(tech: Technology, size = 16, color = "currentColor"): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" color="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${TECH_GLYPH[tech]}</svg>`;
}

function statusDot(status: OperationalStatus, cx: number, cy: number, r: number): string {
  const c = STATUS_COLOR[status];
  if (status === "potential_oos") {
    // Hollow red ring with a dark centre: "potential" — visually distinct from confirmed (solid red + cross).
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#111827" stroke="${c}" stroke-width="5"/>`;
  }
  if (status === "confirmed_oos") {
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c}" stroke="#0b1220" stroke-width="3"/><path d="M${cx - 5} ${cy - 5}l10 10M${cx + 5} ${cy - 5}l-10 10" stroke="white" stroke-width="3" stroke-linecap="round"/>`;
  }
  if (status === "unknown") {
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c}" stroke="#0b1220" stroke-width="3"/><text x="${cx}" y="${cy + 5}" font-size="14" font-weight="700" text-anchor="middle" fill="white" font-family="Arial">?</text>`;
  }
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c}" stroke="#0b1220" stroke-width="3"/>`;
}

/** 80×80 marker SVG: technology disc + glyph + status indicator (top-right). */
export function markerSvg(tech: Technology, status: OperationalStatus): string {
  const color = TECH_COLOR[tech];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80">
<circle cx="36" cy="44" r="29" fill="${color}" stroke="#0b1220" stroke-width="4"/>
<circle cx="36" cy="44" r="25" fill="none" stroke="rgba(255,255,255,0.55)" stroke-width="2"/>
<g transform="translate(18 26) scale(1.5)" fill="none" stroke="white" color="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${TECH_GLYPH[tech]}</g>
${statusDot(status, 64, 16, 12)}
</svg>`;
}

export function statusBadgeSvg(status: OperationalStatus, size = 12): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 40 40">${statusDot(status, 20, 20, 14)}</svg>`;
}

export const fmtMW = (v: number | null | undefined, digits = 0): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v.toLocaleString("en-CA", { maximumFractionDigits: digits, minimumFractionDigits: digits })} MW`;

export const fmtNum = (v: number | null | undefined, digits = 0): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toLocaleString("en-CA", { maximumFractionDigits: digits, minimumFractionDigits: digits });

export const fmtPct = (v: number | null | undefined, digits = 0): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v.toFixed(digits)}%`;

export const ONTARIO_BOUNDS: [[number, number], [number, number]] = [
  [-95.2, 41.6],
  [-74.3, 56.9],
];

export const MAP_STYLES = {
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  light: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
};

export const REGIONS = ["Toronto", "Southwest", "Niagara", "East", "Essa", "Ottawa", "Bruce", "West", "Northeast", "Northwest"];
