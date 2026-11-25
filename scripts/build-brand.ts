// Generates the Pasar x402 brand kit: logo mark, lockups, X/Twitter banner, Open Graph image, favicons.
// Text is converted to SVG paths so every file renders identically without the fonts installed.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import opentype, { type Font, type PathCommand } from "opentype.js";

const { parse } = opentype;

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, "brand");
const WEB_ASSETS = resolve(ROOT, "web/assets");

// Black and lime, matching the website. "olive" is the readable lime for light backgrounds.
const C = {
  ink: "#0A0A0B",
  paper: "#F4F3F1",
  terpal: "#CCFF00",
  terpalLight: "#CCFF00",
  olive: "#4A6100",
  label: "#CCFF00",
  muted: "#A7A5A1",
};

function loadFont(pkg: string, file: string): Font {
  const buffer = readFileSync(resolve(ROOT, "node_modules/@fontsource", pkg, "files", file));
  return parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);
}

const fonts = {
  display: loadFont("archivo-black", "archivo-black-latin-400-normal.woff"),
  body: loadFont("atkinson-hyperlegible", "atkinson-hyperlegible-latin-700-normal.woff"),
  mono: loadFont("martian-mono", "martian-mono-latin-500-normal.woff"),
  monoBold: loadFont("martian-mono", "martian-mono-latin-700-normal.woff"),
  marker: loadFont("permanent-marker", "permanent-marker-latin-400-normal.woff"),
};

type TextOptions = { font: Font; size: number; fill: string; anchor?: "start" | "middle" | "end"; opacity?: number };

function width(text: string, font: Font, size: number) {
  return font.getAdvanceWidth(text, size);
}

const n = (v: number) => (Math.round(v * 100) / 100).toString();

/**
 * Serialises glyph outlines ourselves: opentype.js 2.0's toPathData rounds via string
 * concatenation and emits NaN for values close to an integer (e.g. 1e-14), which
 * makes SVG renderers drop the rest of the path.
 */
function pathData(commands: PathCommand[]) {
  return commands
    .map((c) => {
      switch (c.type) {
        case "M":
        case "L":
          return `${c.type}${n(c.x!)} ${n(c.y!)}`;
        case "Q":
          return `Q${n(c.x1!)} ${n(c.y1!)} ${n(c.x!)} ${n(c.y!)}`;
        case "C":
          return `C${n(c.x1!)} ${n(c.y1!)} ${n(c.x2!)} ${n(c.y2!)} ${n(c.x!)} ${n(c.y!)}`;
        default:
          return "Z";
      }
    })
    .join("");
}

/** Text as a filled path; x is the anchor point, y the baseline. */
function text(value: string, x: number, y: number, o: TextOptions) {
  const w = width(value, o.font, o.size);
  const startX = o.anchor === "middle" ? x - w / 2 : o.anchor === "end" ? x - w : x;
  const d = pathData(o.font.getPath(value, startX, y, o.size).commands);
  return `<path d="${d}" fill="${o.fill}"${o.opacity ? ` fill-opacity="${o.opacity}"` : ""}/>`;
}

/** Striped market awning with a scalloped edge. */
function awning(x0: number, y0: number, totalWidth: number, stripe: number, depth: number, colors: [string, string]) {
  const r = stripe / 2;
  let out = "";
  for (let i = 0; i * stripe < totalWidth; i++) {
    const x = x0 + i * stripe;
    out += `<path d="M${x} ${y0}h${stripe}v${depth}a${r} ${r} 0 0 1 -${stripe} 0z" fill="${colors[i % 2]}"/>`;
  }
  return out;
}

/** A hanging price tag (house-shaped card with a hole), centred on cx with its point at top y. */
function tag(cx: number, top: number, w: number, h: number, angle: number, inner: string, fill = C.label) {
  const half = w / 2;
  const shoulder = w * 0.28;
  const r = Math.min(6, w * 0.06);
  const d = [
    `M${cx - half} ${top + shoulder}`,
    `L${cx} ${top}`,
    `L${cx + half} ${top + shoulder}`,
    `V${top + h - r}`,
    `a${r} ${r} 0 0 1 -${r} ${r}`,
    `H${cx - half + r}`,
    `a${r} ${r} 0 0 1 -${r} -${r}`,
    "Z",
  ].join("");
  const hole = `<circle cx="${cx}" cy="${top + shoulder * 0.62}" r="${Math.max(1.6, w * 0.055)}" fill="${C.ink}"/>`;
  return `<g transform="rotate(${angle} ${cx} ${top})"><path d="${d}" fill="${fill}"/>${hole}${inner}</g>`;
}

function svg(w: number, h: number, body: string, label: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${label}">${body}</svg>\n`;
}

// ---------------------------------------------------------------------------
// Logo mark (64 x 64): an awning with a "402" price tag hanging between two scallops.
function markBody(dark = true) {
  const tile = dark ? C.ink : C.paper;
  const rail = dark ? C.paper : C.ink;
  const stripeB = dark ? C.paper : C.ink;
  return [
    `<rect width="64" height="64" rx="14" fill="${tile}"/>`,
    `<rect x="6" y="8.5" width="52" height="3.5" rx="1.75" fill="${rail}"/>`,
    awning(8, 11, 48, 12, 11, [C.terpal, stripeB]),
    `<path d="M32 22.5V35" stroke="${rail}" stroke-width="1.4" stroke-linecap="round"/>`,
    tag(32, 33, 25, 24, -8, text("402", 32, 52.2, { font: fonts.display, size: 9, fill: C.ink, anchor: "middle" })),
  ].join("");
}

const mark = svg(64, 64, markBody(true), "Pasar x402");
const markLight = svg(64, 64, markBody(false), "Pasar x402");

// Horizontal lockup.
function lockup(onDark: boolean) {
  const wordSize = 40;
  const pasarW = width("Pasar", fonts.display, wordSize);
  const gap = 12;
  const x402Size = 31;
  const x402W = width("x402", fonts.monoBold, x402Size);
  const total = Math.ceil(80 + pasarW + gap + x402W + 12);
  const body = [
    `<g transform="translate(8 8)">${markBody(true)}</g>`,
    text("Pasar", 86, 54, { font: fonts.display, size: wordSize, fill: onDark ? C.paper : C.ink }),
    text("x402", 86 + pasarW + gap, 53, { font: fonts.monoBold, size: x402Size, fill: onDark ? C.terpalLight : C.olive }),
  ].join("");
  return svg(total, 80, body, "Pasar x402");
}

// ---------------------------------------------------------------------------
// Banner and Open Graph image.
type Copy = { tagline: string; meta: string; tags: [string, string][] };
const COPY: Copy = {
  tagline: "Pay-per-request for AI agents on BNB Chain",
  meta: "Self-hosted facilitator · EIP-3009 · BSC Testnet · Open source",
  tags: [
    ["$0.01", "token check"],
    ["$0.02", "ask AI"],
    ["$0.03", "content"],
  ],
};

function hangingTags(copy: Copy, centers: number[], scallopBottom: number, lengths: number[], angles: number[], w: number, h: number) {
  return copy.tags
    .map(([price, label], i) => {
      const cx = centers[i];
      const top = scallopBottom + lengths[i];
      // Shrink long labels so they keep a margin inside the tag.
      const labelSize = Math.min(w * 0.115, (w * 0.8) / width(label, fonts.mono, 1));
      const inner =
        text(price, cx, top + h * 0.62, { font: fonts.marker, size: w * 0.33, fill: C.ink, anchor: "middle" }) +
        text(label, cx, top + h * 0.84, { font: fonts.mono, size: labelSize, fill: C.ink, anchor: "middle" });
      const string = `<path d="M${cx} ${scallopBottom - 2}V${top + w * 0.17}" stroke="${C.paper}" stroke-opacity="0.75" stroke-width="2"/>`;
      return string + tag(cx, top, w, h, angles[i], inner);
    })
    .join("");
}

function banner() {
  const W = 1500;
  const H = 500;
  const copy = COPY;
  const stripe = 60;
  const depth = 50;
  const scallopBottom = depth + stripe / 2;
  const pasarSize = 118;
  const pasarW = width("Pasar", fonts.display, pasarSize);
  const body = [
    `<rect width="${W}" height="${H}" fill="${C.ink}"/>`,
    awning(0, 0, W, stripe, depth, [C.terpal, C.paper]),
    text("HTTP/1.1 402 Payment Required", 96, 196, { font: fonts.mono, size: 21, fill: C.label }),
    text("Pasar", 92, 300, { font: fonts.display, size: pasarSize, fill: C.paper }),
    text("x402", 92 + pasarW + 26, 298, { font: fonts.monoBold, size: 88, fill: C.terpalLight }),
    text(copy.tagline, 96, 356, { font: fonts.body, size: 34, fill: C.paper, opacity: 0.92 }),
    hangingTags(copy, [1050, 1170, 1290], scallopBottom, [64, 104, 52], [-6, 4, -3], 108, 132),
    text(copy.meta, W - 72, 462, { font: fonts.mono, size: 16, fill: C.muted, anchor: "end" }),
  ].join("");
  return svg(W, H, body, `Pasar x402 — ${copy.tagline}`);
}

function openGraph() {
  const W = 1200;
  const H = 630;
  const copy = COPY;
  const stripe = 60;
  const depth = 46;
  const scallopBottom = depth + stripe / 2;
  const pasarSize = 104;
  const pasarW = width("Pasar", fonts.display, pasarSize);
  const body = [
    `<rect width="${W}" height="${H}" fill="${C.ink}"/>`,
    awning(0, 0, W, stripe, depth, [C.terpal, C.paper]),
    text("HTTP/1.1 402 Payment Required", 80, 250, { font: fonts.mono, size: 22, fill: C.label }),
    text("Pasar", 76, 360, { font: fonts.display, size: pasarSize, fill: C.paper }),
    text("x402", 76 + pasarW + 22, 358, { font: fonts.monoBold, size: 78, fill: C.terpalLight }),
    text(copy.tagline, 80, 420, { font: fonts.body, size: 31, fill: C.paper, opacity: 0.92 }),
    text(copy.meta, 80, 560, { font: fonts.mono, size: 16, fill: C.muted }),
    hangingTags({ ...copy, tags: copy.tags.slice(0, 2) as [string, string][] }, [930, 1050], scallopBottom, [70, 118], [-5, 4], 104, 128),
  ].join("");
  return svg(W, H, body, `Pasar x402 — ${copy.tagline}`);
}

// ---------------------------------------------------------------------------
function png(svgSource: string, file: string, widthPx?: number) {
  const resvg = new Resvg(svgSource, widthPx ? { fitTo: { mode: "width", value: widthPx } } : undefined);
  writeFileSync(resolve(OUT, file), resvg.render().asPng());
}

mkdirSync(OUT, { recursive: true });
mkdirSync(WEB_ASSETS, { recursive: true });

const files: Record<string, string> = {
  "logo-mark.svg": mark,
  "logo-mark-light.svg": markLight,
  "logo-light.svg": lockup(false),
  "logo-dark.svg": lockup(true),
  "banner.svg": banner(),
  "og.svg": openGraph(),
};
for (const [file, source] of Object.entries(files)) writeFileSync(resolve(OUT, file), source);

png(mark, "logo-mark-512.png", 512);
png(mark, "favicon-32.png", 32);
png(mark, "apple-touch-icon.png", 180);
png(lockup(false), "logo-light.png", 1440);
png(lockup(true), "logo-dark.png", 1440);
png(files["banner.svg"], "banner.png");
png(files["og.svg"], "og.png");

for (const file of ["logo-mark.svg", "logo-light.svg", "logo-dark.svg", "favicon-32.png", "apple-touch-icon.png", "og.png"]) {
  copyFileSync(resolve(OUT, file), resolve(WEB_ASSETS, file));
}
console.log(`Brand kit written to brand/ (${Object.keys(files).length} SVG + 7 PNG), web assets copied.`);
