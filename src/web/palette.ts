export const paletteAsset = "plugins/palette/colors.css";
export const paletteIds = ["brown", "ins-blue", "light-pink", "lipstick-red"] as const;
export type PaletteId = typeof paletteIds[number];
export type PageColors = Readonly<Record<"light" | "dark", string>>;
export type PalettePageColors = Partial<Record<PaletteId, PageColors>>;

export function palettePreference(cookie?: string): PaletteId | undefined {
  const value = cookie?.match(/(?:^|;\s*)zigent_palette=([^;]*)/)?.[1];
  return paletteIds.find(id => id === value);
}

/** HTML metadata and the install manifest require literal sRGB colors. */
export function pageColors(css: string, property = "--palette-page"): PalettePageColors {
  const paints: Partial<Record<PaletteId, Partial<PageColors>>> = {};
  const value = new RegExp(`${property}\\s*:\\s*(#[0-9a-fA-F]{6})\\s*;`);
  for (const [, selectors, declarations] of css.matchAll(/:root((?:\[data-(?:palette|theme)="[a-z-]+"\])*)\s*\{([^{}]*)\}/g)) {
    const color = declarations!.match(value)?.[1];
    if (!color) continue;
    const name = selectors!.match(/\[data-palette="([a-z-]+)"\]/)?.[1] ?? "brown";
    const id = paletteIds.find(candidate => candidate === name);
    if (!id) throw new Error("WEB_PALETTE_ID_INVALID");
    const mode = selectors!.includes('[data-theme="dark"]') ? "dark" : "light";
    paints[id] = { ...paints[id], [mode]: color };
  }
  const colors: PalettePageColors = {};
  for (const id of paletteIds) {
    const selected = paints[id];
    if (!selected && id !== "brown") continue; // Historical bundles only have brown.
    if (!selected?.light || !selected.dark) throw new Error("WEB_PALETTE_PAGE_COLORS_INVALID");
    colors[id] = { light: selected.light, dark: selected.dark };
  }
  return colors;
}
