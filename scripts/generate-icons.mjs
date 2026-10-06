// Renders every icon size the web app, the Android app, and the App Store
// need from the Luban bridge mark in public/brand/luban-mark.svg (the logo's
// bridge without the wordmark): lavender on white, as in the logo.
//
// Writes:
//   public/icons/icon.svg            white rounded tile, transparent corners ("any")
//   public/icons/icon-maskable.svg   full bleed, mark inside the maskable safe zone
//   public/icons/icon-192.png, icon-512.png            from icon.svg
//   public/icons/icon-maskable-512.png                 from icon-maskable.svg
//   public/icons/apple-touch-icon.png (180), icon-1024.png
//                                    from icon-maskable.svg, opaque RGB with no
//                                    alpha channel (iOS and App Store Connect
//                                    reject icons that have one)
//   app/favicon.ico                  16, 32, and 48 px PNGs of the bare mark on a
//                                    transparent background, for browser tabs
//   app/opengraph-image.png          1200x630 link preview: the full logo
//                                    (public/brand/luban-logo.svg) on white
//
// Rerun after changing the logo:  node scripts/generate-icons.mjs
// Renders with the installed Google Chrome, or Playwright's own Chromium.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { chromium } from "@playwright/test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ICON_DIR = join(repoRoot, "public", "icons");

const PAPER = "#ffffff";

// The mark's viewBox in public/brand/luban-mark.svg.
const MARK = { x: 6, y: 14, width: 180, height: 124 };
const markSource = await readFile(join(repoRoot, "public", "brand", "luban-mark.svg"), "utf8");
const markBody = markSource
  .replace(/^[\s\S]*?<svg[^>]*>/, "")
  .replace(/<\/svg>\s*$/, "")
  .replace(/<title>[\s\S]*?<\/title>/, "");

/** The mark centred on a 512 grid at `width` units wide. */
function mark(width) {
  const scale = width / MARK.width;
  const left = 256 - width / 2;
  const top = 256 - (MARK.height * scale) / 2;
  return `<g transform="translate(${left.toFixed(2)} ${top.toFixed(2)}) scale(${scale.toFixed(4)}) translate(${-MARK.x} ${-MARK.y})">${markBody}</g>`;
}

// "any" icon: a white rounded tile with the mark across 80% of it.
const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="${PAPER}"/>
  ${mark(410)}
</svg>
`;

// Maskable icon: full bleed so any mask shape works; the mark stays inside
// the central circle (radius 40% of the icon) that every mask keeps.
const maskableSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${PAPER}"/>
  ${mark(330)}
</svg>
`;

// Browser-tab favicon: the bare mark, as large as the square allows, with
// its lines thickened so they survive at 16 and 32 px.
const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <style>path { stroke-width: 9px; }</style>
  ${mark(492)}
</svg>
`;

// Link preview for shared invitation links: the full logo, centred on white.
const logoSource = await readFile(join(repoRoot, "public", "brand", "luban-logo.svg"), "utf8");
const LOGO = { width: 180, height: 160 };
const OG = { width: 1200, height: 630, logoHeight: 430 };
const ogLogoWidth = (LOGO.width * OG.logoHeight) / LOGO.height;
const ogSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${OG.width} ${OG.height}">
  <rect width="${OG.width}" height="${OG.height}" fill="${PAPER}"/>
  <image href="data:image/svg+xml;base64,${Buffer.from(logoSource).toString("base64")}"
    x="${(OG.width - ogLogoWidth) / 2}" y="${(OG.height - OG.logoHeight) / 2}"
    width="${ogLogoWidth}" height="${OG.logoHeight}"/>
</svg>
`;

// --- PNG and ICO encoding ---------------------------------------------------

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * Encodes RGBA pixels as a PNG, square unless `height` is given; `opaque`
 * drops the alpha channel entirely.
 */
function encodePng(rgba, size, opaque, height = size) {
  const channels = opaque ? 3 : 4;
  const raw = Buffer.alloc(height * (size * channels + 1));
  for (let y = 0; y < height; y += 1) {
    const row = y * (size * channels + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const from = (y * size + x) * 4;
      const to = row + 1 + x * channels;
      raw[to] = rgba[from];
      raw[to + 1] = rgba[from + 1];
      raw[to + 2] = rgba[from + 2];
      if (!opaque) raw[to + 3] = rgba[from + 3];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = opaque ? 2 : 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Packs PNG images into an .ico (PNG entries, supported by every current browser). */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map(({ png }) => png)]);
}

// --- Rendering --------------------------------------------------------------

async function launch() {
  try {
    return await chromium.launch({ channel: "chrome" });
  } catch {
    return chromium.launch();
  }
}

/**
 * Rasterizes an SVG at `size` px (square unless `height` is given) in the
 * browser and returns its RGBA pixels.
 */
async function rasterize(page, svg, size, height = size) {
  const pixels = await page.evaluate(
    async ({ svg, size, height }) => {
      const image = new Image();
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = height;
      const context = canvas.getContext("2d");
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, size, height);
      return Array.from(context.getImageData(0, 0, size, height).data);
    },
    { svg, size, height },
  );
  return Uint8Array.from(pixels);
}

async function main() {
  await mkdir(ICON_DIR, { recursive: true });
  await writeFile(join(ICON_DIR, "icon.svg"), iconSvg);
  await writeFile(join(ICON_DIR, "icon-maskable.svg"), maskableSvg);

  const browser = await launch();
  try {
    const page = await browser.newPage();
    const outputs = [
      { file: "icon-192.png", svg: iconSvg, size: 192, opaque: false },
      { file: "icon-512.png", svg: iconSvg, size: 512, opaque: false },
      { file: "icon-maskable-512.png", svg: maskableSvg, size: 512, opaque: true },
      { file: "apple-touch-icon.png", svg: maskableSvg, size: 180, opaque: true },
      { file: "icon-1024.png", svg: maskableSvg, size: 1024, opaque: true },
    ];
    for (const { file, svg, size, opaque } of outputs) {
      const png = encodePng(await rasterize(page, svg, size), size, opaque);
      await writeFile(join(ICON_DIR, file), png);
      console.log(`public/icons/${file}  ${size}px  ${png.length} bytes`);
    }

    const favicons = [];
    for (const size of [16, 32, 48]) {
      favicons.push({ size, png: encodePng(await rasterize(page, faviconSvg, size), size, false) });
    }
    const og = encodePng(await rasterize(page, ogSvg, OG.width, OG.height), OG.width, true, OG.height);
    await writeFile(join(repoRoot, "app", "opengraph-image.png"), og);
    await writeFile(join(repoRoot, "app", "opengraph-image.alt.txt"), "The Luban logo: a suspension bridge above the word LuBan.");
    console.log(`app/opengraph-image.png  ${OG.width}x${OG.height}px  ${og.length} bytes`);

    const ico = encodeIco(favicons);
    await writeFile(join(repoRoot, "app", "favicon.ico"), ico);
    console.log(`app/favicon.ico  16/32/48px  ${ico.length} bytes`);
  } finally {
    await browser.close();
  }
}

await main();
