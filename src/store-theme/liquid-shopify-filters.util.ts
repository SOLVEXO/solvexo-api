/* eslint-disable prettier/prettier */
import type { Liquid } from 'liquidjs';

// Shopify Liquid filters/helpers that liquidjs does not ship: translations
// (`t`), colour maths, font helpers, small tag helpers, plus schema-default
// resolution for settings. Pure functions — no I/O, safe to run per request.

type PackageFileLike = { path: string; encoding: string; content: string };

// ── Translations ────────────────────────────────────────────────────────────
function lookup(tree: any, key: string): unknown {
  return key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), tree);
}

export function loadLocale(files: PackageFileLike[], locale = 'en'): Record<string, any> {
  const candidates = [`locales/${locale}.json`, `locales/${locale}.default.json`, 'locales/en.default.json', 'locales/en.json'];
  const merged: Record<string, any> = {};
  for (const path of [...candidates].reverse()) {
    const file = files.find((f) => f.path === path && f.encoding === 'utf8');
    if (!file) continue;
    try {
      // Shopify locale files may start with a /* comment */ block.
      const parsed = JSON.parse(file.content.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, ''));
      deepAssign(merged, parsed);
    } catch { /* ignore a broken locale file; keys fall back to "translation missing" */ }
  }
  return merged;
}
function deepAssign(target: any, source: any) {
  for (const [k, v] of Object.entries(source ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) { target[k] = target[k] ?? {}; deepAssign(target[k], v); }
    else target[k] = v;
  }
}

/** liquidjs passes `key: value` filter arguments as `[key, value]` pairs. */
function namedArgs(args: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args) if (Array.isArray(arg) && arg.length === 2 && typeof arg[0] === 'string') out[arg[0]] = arg[1];
  return out;
}

export function translate(locale: Record<string, any>, key: string, args: unknown[], localeName = 'en'): string {
  const vars = namedArgs(args);
  let entry = lookup(locale, key);
  if (entry && typeof entry === 'object') {
    const count = Number(vars.count);
    const plural = count === 0 && 'zero' in (entry as any) ? 'zero' : count === 1 ? 'one' : 'other';
    entry = (entry as any)[plural] ?? (entry as any).other;
  }
  if (typeof entry !== 'string') return `translation missing: ${localeName}.${key}`;
  return entry.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, name: string) => (vars[name] === undefined ? '' : String(vars[name])));
}

// ── Colour maths ────────────────────────────────────────────────────────────
type RGBA = { r: number; g: number; b: number; a: number };

function parseColor(input: unknown): RGBA | null {
  const text = String(input ?? '').trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(text);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  m = /^rgba?\(([^)]+)\)$/.exec(text);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (p.length >= 3 && p.every(Number.isFinite)) return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
  }
  return null;
}
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
function toHex({ r, g, b }: RGBA): string {
  return `#${[r, g, b].map((c) => clamp(Math.round(c), 0, 255).toString(16).padStart(2, '0')).join('')}`;
}
function rgbToHsl({ r, g, b }: RGBA): { h: number; s: number; l: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return { h: h * 60, s: s * 100, l: l * 100 };
}
function hslToRgb(h: number, s: number, l: number, a = 1): RGBA {
  const sn = clamp(s, 0, 100) / 100, ln = clamp(l, 0, 100) / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const f = (n: number) => ln - sn * Math.min(ln, 1 - ln) * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255, a };
}
function luminance({ r, g, b }: RGBA): number {
  const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
const formatColor = (c: RGBA) => (c.a < 1 ? `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${+c.a.toFixed(3)})` : toHex(c));

function adjust(color: unknown, key: 'lightness' | 'saturation', delta: number): string {
  const rgba = parseColor(color);
  if (!rgba) return String(color ?? '');
  const hsl = rgbToHsl(rgba);
  hsl[key === 'lightness' ? 'l' : 's'] = clamp(hsl[key === 'lightness' ? 'l' : 's'] + delta, 0, 100);
  return formatColor(hslToRgb(hsl.h, hsl.s, hsl.l, rgba.a));
}

// ── Registration ────────────────────────────────────────────────────────────
export function registerShopifyFilters(engine: Liquid, files: PackageFileLike[], localeName = 'en'): void {
  const locale = loadLocale(files, localeName);
  engine.registerFilter('t', (key: unknown, ...args: unknown[]) => translate(locale, String(key ?? ''), args, localeName));
  engine.registerFilter('translate', (key: unknown, ...args: unknown[]) => translate(locale, String(key ?? ''), args, localeName));

  engine.registerFilter('color_to_rgb', (c: unknown) => { const p = parseColor(c); return p ? (p.a < 1 ? `rgba(${p.r}, ${p.g}, ${p.b}, ${p.a})` : `rgb(${p.r}, ${p.g}, ${p.b})`) : String(c ?? ''); });
  engine.registerFilter('color_to_hex', (c: unknown) => { const p = parseColor(c); return p ? toHex(p) : String(c ?? ''); });
  engine.registerFilter('color_to_hsl', (c: unknown) => { const p = parseColor(c); if (!p) return String(c ?? ''); const h = rgbToHsl(p); return p.a < 1 ? `hsla(${Math.round(h.h)}, ${Math.round(h.s)}%, ${Math.round(h.l)}%, ${p.a})` : `hsl(${Math.round(h.h)}, ${Math.round(h.s)}%, ${Math.round(h.l)}%)`; });
  engine.registerFilter('color_lighten', (c: unknown, amount: unknown) => adjust(c, 'lightness', Number(amount) || 0));
  engine.registerFilter('color_darken', (c: unknown, amount: unknown) => adjust(c, 'lightness', -(Number(amount) || 0)));
  engine.registerFilter('color_saturate', (c: unknown, amount: unknown) => adjust(c, 'saturation', Number(amount) || 0));
  engine.registerFilter('color_desaturate', (c: unknown, amount: unknown) => adjust(c, 'saturation', -(Number(amount) || 0)));
  engine.registerFilter('color_brightness', (c: unknown) => { const p = parseColor(c); return p ? Math.round((p.r * 299 + p.g * 587 + p.b * 114) / 1000) : 0; });
  engine.registerFilter('color_contrast', (a: unknown, b: unknown) => {
    const pa = parseColor(a), pb = parseColor(b);
    if (!pa || !pb) return 1;
    const [hi, lo] = [luminance(pa), luminance(pb)].sort((x, y) => y - x);
    return +(((hi + 0.05) / (lo + 0.05)).toFixed(1));
  });
  engine.registerFilter('color_difference', (a: unknown, b: unknown) => {
    const pa = parseColor(a), pb = parseColor(b);
    if (!pa || !pb) return 0;
    return Math.round(Math.abs(pa.r - pb.r) + Math.abs(pa.g - pb.g) + Math.abs(pa.b - pb.b));
  });
  engine.registerFilter('color_modify', (c: unknown, attribute: unknown, value: unknown) => {
    const p = parseColor(c);
    if (!p) return String(c ?? '');
    const n = Number(value);
    switch (String(attribute)) {
      case 'red': return formatColor({ ...p, r: clamp(n, 0, 255) });
      case 'green': return formatColor({ ...p, g: clamp(n, 0, 255) });
      case 'blue': return formatColor({ ...p, b: clamp(n, 0, 255) });
      case 'alpha': return formatColor({ ...p, a: clamp(n, 0, 1) });
      case 'hue': { const h = rgbToHsl(p); return formatColor(hslToRgb(n, h.s, h.l, p.a)); }
      case 'saturation': { const h = rgbToHsl(p); return formatColor(hslToRgb(h.h, n, h.l, p.a)); }
      case 'lightness': { const h = rgbToHsl(p); return formatColor(hslToRgb(h.h, h.s, n, p.a)); }
      default: return String(c);
    }
  });

  // Fonts: the sandboxed storefront can't load remote font files, so these
  // degrade to the CSS font stack the setting names instead of throwing.
  engine.registerFilter('font_face', () => '');
  engine.registerFilter('font_url', () => '');
  engine.registerFilter('font_modify', (font: unknown) => font);

  engine.registerFilter('link_to', (text: unknown, url: unknown) => `<a href="${escapeHtml(String(url ?? ''))}">${String(text ?? '')}</a>`);
  engine.registerFilter('placeholder_svg_tag', (name: unknown, klass: unknown) =>
    `<svg class="placeholder-svg ${escapeHtml(String(klass ?? ''))}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 525 525" role="img" aria-label="${escapeHtml(String(name ?? 'placeholder'))}"><rect width="525" height="525" fill="#f2f2f2"/></svg>`);
  engine.registerFilter('pluralize', (n: unknown, singular: unknown, plural: unknown) => (Number(n) === 1 ? singular : plural));
  engine.registerFilter('weight_with_unit', (grams: unknown) => `${(Number(grams) / 1000).toFixed(1)} kg`);
  engine.registerFilter('default_pagination', (paginate: any) => {
    const parts = Number(paginate?.pages) > 1 ? paginate.parts : null;
    if (!Array.isArray(parts)) return '';
    return `<nav class="pagination" aria-label="Pagination">${parts.map((p: any) => (p.url ? `<a href="${escapeHtml(String(p.url))}">${escapeHtml(String(p.title))}</a>` : `<span>${escapeHtml(String(p.title))}</span>`)).join(' ')}</nav>`;
  });
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Schema defaults ─────────────────────────────────────────────────────────
function readSchema(content: string): any | null {
  const m = /\{%[-+]?\s*schema\s*[-+]?%\}([\s\S]*?)\{%[-+]?\s*endschema\s*[-+]?%\}/i.exec(content);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}
function defaultsOf(settings: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(settings)) return out;
  for (const s of settings) if (s && typeof s.id === 'string' && s.default !== undefined) out[s.id] = s.default;
  return out;
}

/** Fills theme-wide settings the merchant never touched with their `settings_schema.json` defaults. */
export function applyThemeSettingDefaults(files: PackageFileLike[], settings: Record<string, any>): Record<string, any> {
  const file = files.find((f) => f.path === 'config/settings_schema.json' && f.encoding === 'utf8');
  if (!file) return settings;
  let groups: any;
  try { groups = JSON.parse(file.content); } catch { return settings; }
  const defaults: Record<string, unknown> = {};
  for (const group of Array.isArray(groups) ? groups : []) Object.assign(defaults, defaultsOf(group?.settings));
  return { ...defaults, ...settings };
}

/** Section + block setting defaults from the section's own `{% schema %}`. */
export function applySectionSettingDefaults(fileContent: string, section: { settings?: Record<string, any>; blocks?: Record<string, any> }) {
  const schema = readSchema(fileContent);
  if (!schema) return { settings: section.settings ?? {}, blocks: section.blocks ?? {} };
  const settings = { ...defaultsOf(schema.settings), ...(section.settings ?? {}) };
  const blockDefaults: Record<string, Record<string, unknown>> = {};
  for (const b of Array.isArray(schema.blocks) ? schema.blocks : []) if (b?.type) blockDefaults[b.type] = defaultsOf(b.settings);
  const blocks = Object.fromEntries(Object.entries(section.blocks ?? {}).map(([id, block]: [string, any]) => [
    id, { ...block, settings: { ...(blockDefaults[block?.type] ?? {}), ...(block?.settings ?? {}) } },
  ]));
  return { settings, blocks };
}
