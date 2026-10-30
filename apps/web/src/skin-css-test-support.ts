// Test helper (SKIN-A). Reads apps/web/src/app/globals.css as text and returns the custom properties
// each skin declares, in file order. No CSS parser is a dependency (D-008): the stylesheet keeps one
// declaration per line, no nested rules except @media, so a flat rule scan is enough.
import { readFileSync } from 'node:fs';

export const SKINS = ['market', 'harbour'] as const;
export type SkinName = (typeof SKINS)[number];

export function readGlobalsCss(): string {
  return readFileSync(new URL('./app/globals.css', import.meta.url), 'utf8');
}

export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Custom properties of the rule whose selector names `:root[data-skin='<skin>']`, in file order. */
export function skinTokens(css: string, skin: SkinName): Array<[string, string]> {
  const rules = [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const hit = rules.filter((m) => (m[1] ?? '').includes(`:root[data-skin='${skin}']`));
  if (hit.length !== 1)
    throw new Error(`expected one :root[data-skin='${skin}'] rule, got ${hit.length}`);
  const out: Array<[string, string]> = [];
  for (const d of (hit[0]?.[2] ?? '').matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g))
    out.push([d[1] ?? '', (d[2] ?? '').replace(/\s+/g, ' ').trim()]);
  return out;
}

export function tokenMap(css: string, skin: SkinName): Record<string, string> {
  return Object.fromEntries(skinTokens(css, skin));
}

// WCAG 2.2 relative luminance and contrast ratio for #rrggbb values.
export function luminance(hex: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`not a #rrggbb colour: ${hex}`);
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

export function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
