// Captures the annotated screenshots used by the beginner's how-to guide
// (lubancanada.com/sim-guide). Each shot is clipped to one feature and marked
// with red ellipses and numbered badges; the guide text refers to those
// numbers, so keep the target order stable when editing the shot list.
//
// It only reads: it signs in as a demo user, opens dialogs, types into fields,
// hovers, and picks options, then reloads. It never places, submits, or
// cancels an order.
//
// Rerun against a running demo-mode dev server (live market data):
//   node scripts/capture-guide-screenshots.mjs
// Options (env vars):
//   BASE_URL   app to capture   (default http://localhost:3002)
//   OUT_DIR    image folder     (default ../assets/images/sim-guide)
//   DEMO_USER  demo identity    (default alex)
//   ONLY       comma-separated shot names to capture, e.g. ONLY=07-chart,08-advanced-view

import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3002";
const OUT_DIR = resolve(process.env.OUT_DIR ?? join(repoRoot, "..", "assets", "images", "sim-guide"));
const DEMO_USER = process.env.DEMO_USER ?? "alex";
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",").map((name) => name.trim())) : null;

const VIEWPORT = { width: 1440, height: 900 };
const PADDING = 16;
const JPEG_QUALITY = 85;

const SHOT_CSS = `
  .identity-switcher { visibility: hidden !important; }
  nextjs-portal { display: none !important; }
  *, *::before, *::after, ::backdrop {
    transition: none !important;
    animation: none !important;
    caret-color: transparent !important;
  }
`;

// --- Page helpers ----------------------------------------------------------

async function openApp(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator(".status-footer").getByText("Connected", { exact: true }).waitFor({ timeout: 60_000 });
  await page.waitForFunction(
    () => {
      const price = document.querySelector(".quote-price strong")?.textContent?.trim();
      return price && price !== "—" && document.querySelector(".quote-chart .chart__plot > svg");
    },
    null,
    { timeout: 60_000 },
  );
  await page.addStyleTag({ content: SHOT_CSS });
  await page.mouse.move(0, 0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
}

/** Viewport rect of a locator, or the union of several. */
async function rectOf(...locators) {
  const rects = [];
  for (const locator of locators) {
    await locator.waitFor({ state: "visible", timeout: 15_000 });
    rects.push(await locator.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    }));
  }
  return unionRects(rects);
}

function unionRects(rects) {
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

const BADGE_SIZE = 28;

/**
 * Viewport rect around just the visible text (and icons) inside a locator,
 * ignoring cell padding and empty space, e.g. a right-aligned table value.
 */
async function textRectOf(locator) {
  await locator.waitFor({ state: "visible", timeout: 15_000 });
  return locator.evaluate((root) => {
    const rects = [];
    const range = document.createRange();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let node = walker.currentNode; node; node = walker.nextNode()) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (!node.textContent.trim() || node.parentElement.closest(".sr-only")) continue;
        range.selectNodeContents(node);
        rects.push(...range.getClientRects());
      } else if (node.matches("svg, img, input, select")) {
        rects.push(node.getBoundingClientRect());
      }
    }
    const visible = rects.filter((r) => r.width > 0 && r.height > 0);
    const pad = 3; // breathing room so glyph edges stay inside the ring
    const left = Math.min(...visible.map((r) => r.left));
    const top = Math.min(...visible.map((r) => r.top));
    return {
      x: left - pad,
      y: top - pad,
      width: Math.max(...visible.map((r) => r.right)) - left + pad * 2,
      height: Math.max(...visible.map((r) => r.bottom)) - top + pad * 2,
    };
  });
}

/**
 * Sizes an ellipse that surrounds the rect: at least `inflate` px bigger on
 * each axis, and large enough that points `slack` px in from each corner sit
 * inside it, so a tall box isn't cut through at its corners. Uses the
 * smallest such ellipse (axes scaled by sqrt 2) when the minimums allow it.
 */
function fitEllipse(rect, { inflateX = 14, inflateY = 10, slack = 4, fit = true }) {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  let rx = rect.width / 2 + inflateX;
  let ry = rect.height / 2 + inflateY;
  // Never wider than the space to the viewport edge, so the ring stays whole.
  const maxRx = Math.max(rx, Math.min(cx, VIEWPORT.width - cx) - 10);
  if (fit) {
    const a = Math.max(0, rect.width / 2 - slack);
    const b = Math.max(0, rect.height / 2 - slack);
    if (a * Math.SQRT2 >= rx && b * Math.SQRT2 >= ry && a * Math.SQRT2 <= maxRx) {
      rx = a * Math.SQRT2;
      ry = b * Math.SQRT2;
    } else if (a * Math.SQRT2 < rx || a * Math.SQRT2 > maxRx) {
      rx = Math.min(Math.max(rx, a * Math.SQRT2), maxRx);
      ry = Math.max(ry, b / Math.sqrt(1 - (a / rx) ** 2));
    } else {
      rx = Math.min(maxRx, Math.max(rx, a / Math.sqrt(1 - (b / ry) ** 2)));
    }
  }
  return { cx, cy, rx, ry };
}

/**
 * Draws red ellipses + numbered badges around each target (numbered in order)
 * and returns the viewport rects the overlays cover, so the clip can include
 * them. Target options: inflateX/inflateY (minimum growth), slack, fit, and
 * badgeAngle (degrees around the ellipse; 135 = upper left, the default).
 * Badges sit just outside the stroke so they never cover the circled feature.
 * Overlays go inside the open dialog when there is one, so they render in the
 * top layer above it.
 */
async function annotate(page, targets) {
  // A target may circle several rects under one number; the badge goes on the first.
  const rings = targets.flatMap((target, index) =>
    [target.rect].flat().map((rect, part) => ({ ...target, rect, number: index + 1, badge: part === 0 })),
  );
  const shapes = rings.map((target) => {
    const { cx, cy, rx, ry } = fitEllipse(target.rect, target);
    const angle = ((target.badgeAngle ?? 135) * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    // Outward normal at that point of the ellipse (screen y points down).
    const nx = cos / rx;
    const ny = -sin / ry;
    const length = Math.hypot(nx, ny);
    const offset = BADGE_SIZE / 2 - 4;
    return {
      number: target.number,
      badge: target.badge,
      x: cx - rx,
      y: cy - ry,
      width: rx * 2,
      height: ry * 2,
      badgeX: cx + rx * cos + (nx / length) * offset - BADGE_SIZE / 2,
      badgeY: cy - ry * sin + (ny / length) * offset - BADGE_SIZE / 2,
    };
  });

  return page.evaluate(({ shapes, size }) => {
    const host = document.querySelector("dialog[open]") ?? document.body;
    const layer = document.createElement("div");
    layer.dataset.guideOverlay = "";
    layer.style.cssText = `position: ${host === document.body ? "absolute" : "fixed"};
      left: 0; top: 0; width: 0; height: 0; overflow: visible;
      pointer-events: none; z-index: 2147483647;`;
    host.append(layer);
    // Measure where the layer actually landed so the same viewport coordinates
    // work in the page, in a dialog, or under a transformed ancestor.
    const origin = layer.getBoundingClientRect();
    const covered = [];

    for (const shape of shapes) {
      const ellipse = document.createElement("div");
      ellipse.style.cssText = `position: absolute; box-sizing: border-box;
        left: ${shape.x - origin.left}px; top: ${shape.y - origin.top}px;
        width: ${shape.width}px; height: ${shape.height}px;
        border: 4px solid #e0001b; border-radius: 50%;
        box-shadow: 0 0 0 2px #fff; pointer-events: none; z-index: 2147483647;`;
      layer.append(ellipse);

      covered.push({ x: shape.x - 2, y: shape.y - 2, width: shape.width + 4, height: shape.height + 4 });
      if (!shape.badge) continue;

      const badge = document.createElement("div");
      badge.textContent = String(shape.number);
      badge.style.cssText = `position: absolute; box-sizing: border-box;
        left: ${shape.badgeX - origin.left}px; top: ${shape.badgeY - origin.top}px;
        width: ${size}px; height: ${size}px; border-radius: 50%;
        background: #e0001b; color: #fff; border: 2px solid #fff;
        font: 700 15px/24px system-ui, -apple-system, "Segoe UI", sans-serif;
        text-align: center; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
        pointer-events: none; z-index: 2147483647;`;
      layer.append(badge);

      covered.push({ x: shape.badgeX - 2, y: shape.badgeY - 2, width: size + 4, height: size + 4 });
    }
    return covered;
  }, { shapes, size: BADGE_SIZE });
}

async function clearAnnotations(page) {
  await page.evaluate(() => document.querySelectorAll("[data-guide-overlay]").forEach((el) => el.remove()));
}

/**
 * Scrolls the regions into view (unless the setup already positioned the page),
 * annotates, and saves a JPEG clipped to the regions and every overlay plus
 * padding. With `fullViewport` it saves the whole viewport instead.
 */
async function shoot(page, name, { regions = [], targets, fullViewport = false, keepScroll = false }) {
  if (regions.length && !fullViewport && !keepScroll) {
    // Centre the regions so overlays have room on every side.
    const r = await rectOf(...regions);
    await page.evaluate(
      ({ top, height }) => window.scrollBy(0, top + height / 2 - window.innerHeight / 2),
      { top: r.y, height: r.height },
    );
    await page.waitForTimeout(150);
  }
  const resolved = [];
  for (const target of targets) {
    resolved.push({ ...target, rect: await target.rect() });
  }
  const covered = await annotate(page, resolved);

  let clip;
  if (!fullViewport) {
    const area = unionRects([await rectOf(...regions), ...covered]);
    const x = Math.max(0, Math.floor(area.x - PADDING));
    const y = Math.max(0, Math.floor(area.y - PADDING));
    clip = {
      x,
      y,
      width: Math.min(VIEWPORT.width, Math.ceil(area.x + area.width + PADDING)) - x,
      height: Math.min(VIEWPORT.height, Math.ceil(area.y + area.height + PADDING)) - y,
    };
  }

  const path = join(OUT_DIR, `${name}.jpg`);
  await page.screenshot({ path, type: "jpeg", quality: JPEG_QUALITY, clip, caret: "hide" });
  await clearAnnotations(page);
  console.log(`saved ${path}`);
}

/** A target from one or more locators: () => union rect. */
const box = (...locators) => () => rectOf(...locators);
/** A target hugging the text inside a locator. */
const text = (locator) => () => textRectOf(locator);

/** Hover the chart plot at a fraction of its width. */
async function hoverPlot(page, plot, fraction) {
  const r = await rectOf(plot);
  await page.mouse.move(r.x + r.width * fraction, r.y + r.height * 0.5);
  await page.waitForTimeout(300);
}

// --- Shot list ---------------------------------------------------------------
// Each entry sets the page up, then returns { region, targets }. Targets are
// numbered in the order listed; the guide text depends on that order.

const shots = {
  async "01-overview"(page) {
    // The columns run past the fold; circle the part that is on screen.
    const visible = (locator) => async () => {
      const r = await rectOf(locator);
      const bottom = Math.min(r.y + r.height, VIEWPORT.height - 14);
      return { x: r.x + 8, y: r.y + 8, width: r.width - 16, height: bottom - r.y - 16 };
    };
    return {
      fullViewport: true,
      targets: [
        { rect: visible(page.locator(".room-column--portfolio")), inflateX: 0, inflateY: 0, fit: false, badgeAngle: 90 },
        { rect: visible(page.locator(".room-column--workbench")), inflateX: 0, inflateY: 0, fit: false, badgeAngle: 90 },
        { rect: visible(page.locator(".room-column--team")), inflateX: 0, inflateY: 0, fit: false, badgeAngle: 90 },
      ],
    };
  },

  async "02-header"(page) {
    const lockup = page.locator(".competition-lockup");
    const strip = page.locator(".simulation-strip");
    return {
      region: page.locator(".app-header"),
      extraRegion: strip,
      targets: [
        { rect: box(lockup.locator("strong"), lockup.locator(".state-tag")) },
        { rect: box(page.locator(".guide-link")) },
        { rect: box(page.locator(".theme-toggle")), inflateX: 10, inflateY: 10 },
        { rect: box(page.getByRole("button", { name: "Send feedback" })), inflateX: 10, inflateY: 10 },
        // A fresh browser hasn't seen any activity, so the bell shows its bubble.
        { rect: box(page.locator(".activity-bell__button")), inflateX: 10, inflateY: 10 },
        { rect: box(strip.locator(":scope > div").last()), inflateY: 8, badgeAngle: 180 },
      ],
    };
  },

  async "03-portfolio-summary"(page) {
    const card = page.locator('section[aria-label="Portfolio value"]');
    const term = (label) => card.locator("dt").filter({ hasText: label }).locator("..");
    return {
      region: card,
      targets: [
        { rect: box(card.getByText("Total portfolio value (CAD)"), card.locator("strong").first()), inflateX: 10, inflateY: 8 },
        { rect: box(term("Daily return")), inflateX: 2, inflateY: 4, fit: false, badgeAngle: 160 },
        { rect: box(term("Total return")), inflateX: 2, inflateY: 4, fit: false, badgeAngle: 20 },
        { rect: box(card.locator(":scope > div").nth(1)), inflateX: 10, inflateY: 8, slack: 12, badgeAngle: 0 },
        { rect: box(term(/^Unrealized/)), inflateX: 6, inflateY: 6, slack: 12 },
        { rect: box(term(/^Realized/)), inflateX: 6, inflateY: 6, slack: 12, badgeAngle: 45 },
      ],
    };
  },

  async "04-portfolio-history"(page) {
    const chart = page.locator(".portfolio-chart");
    return {
      region: chart,
      targets: [
        { rect: box(chart.locator(".range-tabs")) },
        { rect: box(chart.locator(".chart__badge").first()) },
      ],
    };
  },

  async "05-search"(page) {
    const search = page.getByRole("combobox", { name: "Search supported symbols" });
    await search.click();
    await search.pressSequentially("Royal", { delay: 60 });
    const firstOption = page.locator("#symbol-suggestions [role=option]").first();
    await firstOption.waitFor({ timeout: 20_000 });
    await page.waitForTimeout(500);
    return {
      region: page.locator(".symbol-search"),
      extraRegion: page.locator(".symbol-suggestions"),
      targets: [
        { rect: box(page.locator(".symbol-search")) },
        { rect: box(firstOption), inflateX: 8, inflateY: 6 },
      ],
      reload: true,
    };
  },

  async "06-quote"(page) {
    return {
      region: page.locator(".quote-summary"),
      extraRegion: page.locator(".quote-band"),
      targets: [
        { rect: text(page.locator(".quote-meta")), inflateX: 10, inflateY: 6, badgeAngle: 180 },
        { rect: text(page.locator(".quote-price").locator("strong, span").first()), slack: 10, badgeAngle: 180 },
        { rect: box(page.locator(".watch-toggle")), inflateX: 10, inflateY: 10, badgeAngle: 0 },
        { rect: box(page.locator(".quote-band")), inflateX: 8, inflateY: 6, slack: 8, badgeAngle: 225 },
      ],
    };
  },

  async "07-chart"(page) {
    const chart = page.locator(".quote-chart");
    await chart.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await hoverPlot(page, chart.locator(".chart__plot"), 0.6);
    await chart.locator(".chart__tooltip").waitFor({ timeout: 10_000 });
    return {
      region: chart,
      keepScroll: true,
      targets: [
        { rect: box(chart.locator(".range-tabs")) },
        { rect: box(chart.locator(".chart__tooltip")), inflateX: 10, inflateY: 8 },
        { rect: box(chart.locator(".chart-expand")) },
      ],
    };
  },

  async "08-advanced-view"(page) {
    await page.locator(".quote-chart .chart-expand").click();
    const dialog = page.locator("dialog.chart-dialog[open]");
    await dialog.locator(".chart__plot > svg").waitFor({ timeout: 20_000 });
    await dialog.locator(".chart-style").getByRole("button", { name: "Candle" }).click();
    await page.waitForTimeout(500);
    await hoverPlot(page, dialog.locator(".chart__plot"), 0.5);
    const footer = dialog.locator(".chart-dialog__footer");
    return {
      region: dialog,
      keepScroll: true,
      targets: [
        { rect: box(dialog.locator(".chart-style")), inflateX: 10, inflateY: 8 },
        { rect: box(dialog.locator(".chart__readout")), inflateX: 10, inflateY: 8, slack: 0 },
        { rect: box(dialog.locator(".chart__study")), inflateX: 10, inflateY: 8, badgeAngle: 0 },
        { rect: box(footer.locator(".range-tabs"), footer.locator(".chart-dates__toggle")), inflateX: 10, inflateY: 8 },
        { rect: box(footer.locator(".chart-interval")), inflateX: 10, inflateY: 8 },
        { rect: box(dialog.locator(".chart-dialog__close")), inflateX: 8, inflateY: 8 },
      ],
      reload: true,
    };
  },

  async "09-order-ticket"(page) {
    const ticket = page.locator("#order-ticket");
    const receipt = ticket.locator(".ticket-receipt");
    return {
      region: ticket.locator(".ticket-layout"),
      targets: [
        { rect: box(ticket.locator(".side-control")) },
        { rect: box(ticket.locator(".order-type")), inflateX: 10, inflateY: 8 },
        { rect: box(ticket.locator("#order-quantity")), badgeAngle: 180 },
        { rect: box(ticket.locator(".ticket-max")), inflateX: 10, inflateY: 8 },
        { rect: box(receipt.locator("dl")), inflateX: 8, inflateY: 6, fit: false, badgeAngle: 0 },
        { rect: box(receipt.locator("button[type=submit]")) },
        { rect: box(receipt.getByRole("button", { name: "Clear ticket" })), badgeAngle: 180 },
      ],
    };
  },

  async "10-max-confirm"(page) {
    await page.locator("#order-ticket .ticket-max").click();
    const dialog = page.locator("dialog.confirm-dialog[open]");
    await dialog.waitFor();
    await page.mouse.move(0, 0);
    const actions = dialog.locator(".confirm-dialog__actions button");
    return {
      region: dialog,
      keepScroll: true,
      targets: [
        { rect: box(dialog.locator("#max-confirm-body")), inflateX: 10, inflateY: 8, badgeAngle: 180 },
        { rect: box(actions.first()), inflateX: 10, inflateY: 8 },
        { rect: box(actions.last()), inflateX: 10, inflateY: 8 },
      ],
      // Close with Cancel; the quantity is never applied.
      after: () => actions.first().click(),
    };
  },

  async "11-limit-order"(page) {
    const ticket = page.locator("#order-ticket");
    await ticket.locator("#order-type-select").selectOption("LIMIT");
    await ticket.locator("#order-trigger-price").fill("210");
    await ticket.locator("#order-trigger-price").blur();
    // Exits sit behind a button until someone asks for them.
    await ticket.locator("#ticket-exits-add").click();
    await ticket.locator(".ticket-bracket").waitFor();
    await page.locator("#bracket-take-profit").blur();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(300);
    return {
      region: ticket,
      targets: [
        { rect: box(ticket.locator(".order-type")), inflateX: 10, inflateY: 8 },
        { rect: box(ticket.locator("#order-trigger-price")), badgeAngle: 0 },
        { rect: box(ticket.locator("#order-time-in-force")), badgeAngle: 0 },
        { rect: box(ticket.locator(".ticket-bracket")), inflateX: 10, inflateY: 8, slack: 16 },
      ],
      reload: true,
    };
  },

  async "12-holdings"(page) {
    const section = page.locator(".holdings-section");
    const row = section.locator("tbody tr").first();
    return {
      region: section,
      targets: [
        { rect: text(row.locator(".symbol-button")), inflateX: 8, inflateY: 6, slack: 0 },
        { rect: text(row.locator("td").nth(0)), inflateX: 8, inflateY: 6, slack: 0, badgeAngle: 270 },
        { rect: text(row.locator('[data-label="Avg cost"]')), inflateX: 8, inflateY: 6, badgeAngle: 270 },
        { rect: text(row.locator('[data-label="Market value"]')), inflateX: 8, inflateY: 6, badgeAngle: 270 },
        { rect: text(row.locator('[data-label="Gain/loss"]')), inflateX: 8, inflateY: 6, badgeAngle: 270 },
        { rect: box(section.getByRole("button", { name: "Export holdings as CSV" })) },
        { rect: box(section.locator(".portfolio-map-open")), badgeAngle: 45 },
      ],
    };
  },

  async "13-map"(page) {
    await page.locator(".holdings-section .portfolio-map-open").click();
    const dialog = page.locator("dialog.portfolio-map-dialog[open]");
    const tile = dialog.locator(".portfolio-map__tile:not(.portfolio-map__tile--cash)").first();
    await tile.waitFor({ timeout: 20_000 });
    await page.mouse.move(0, 0);
    await page.waitForTimeout(400);
    const control = (label) => dialog.locator(".portfolio-map__control").filter({ hasText: label });
    return {
      region: dialog,
      keepScroll: true,
      targets: [
        { rect: box(control("Color by")), inflateX: 10, inflateY: 8, slack: 0 },
        { rect: box(control("Size by")), inflateX: 10, inflateY: 8, slack: 0 },
        { rect: box(dialog.locator(".portfolio-map__toggle")), inflateX: 10, inflateY: 8 },
        { rect: box(tile), inflateX: 0, inflateY: 0, fit: false, badgeAngle: 90 },
        { rect: box(dialog.locator(".portfolio-map__legend ol")), inflateX: 10, inflateY: 8 },
      ],
      reload: true,
    };
  },

  async "14-waiting-orders"(page) {
    const section = page.locator(".working-orders-section");
    const row = section.locator("tbody tr").first();
    return {
      region: section,
      targets: [
        { rect: text(row.locator("[data-label=Order]")), inflateX: 8, inflateY: 6 },
        { rect: text(row.locator("[data-label=Lasts]")), inflateX: 8, inflateY: 6 },
        { rect: box(row.getByRole("button", { name: /^Cancel/ })), inflateX: 8, inflateY: 6 },
      ],
    };
  },

  async "15-activity"(page) {
    await page.evaluate(() => window.scrollTo(0, 0));
    const bell = page.locator(".activity-bell");
    await bell.locator(".activity-bell__button").click();
    const panel = bell.locator(".activity-bell__panel");
    await panel.waitFor();
    const entry = panel.locator(".activity-list > li").first();
    return {
      region: bell,
      extraRegion: panel,
      keepScroll: true,
      targets: [
        { rect: box(bell.locator(".activity-bell__button")), inflateX: 10, inflateY: 10, badgeAngle: 315 },
        { rect: box(entry), inflateX: 8, inflateY: 6, slack: 12 },
        { rect: box(entry.locator(".activity-state")), inflateX: 10, inflateY: 8 },
      ],
      after: () => page.keyboard.press("Escape"),
    };
  },

  async "16-leaderboard"(page) {
    const section = page.locator(".leaderboard-section");
    return {
      region: page.locator(".presence-section"),
      extraRegion: section,
      targets: [
        { rect: box(page.locator(".presence-list")), inflateX: 10, inflateY: 8, slack: 12 },
        { rect: text(section.locator("tr.is-current .leaderboard-bars__name")), inflateX: 8, inflateY: 6, badgeAngle: 180 },
        // The value column folds under each team's name in the narrow rail.
        { rect: text(section.locator("tr.is-current .leaderboard-bars__inline-value")), inflateX: 10, inflateY: 6, badgeAngle: 225 },
        { rect: box(section.locator("tr.is-current .leaderboard-bars__return")), inflateX: 6, inflateY: 4, slack: 0, badgeAngle: 90 },
      ],
    };
  },

  async "17-footer"(page) {
    const footer = page.locator(".status-footer");
    return {
      region: footer,
      targets: [
        { rect: box(footer.locator(".connection-state")) },
        { rect: text(footer.locator(":scope > div").filter({ hasText: "Last team sync" })) },
        { rect: box(footer.locator(".status-footer__version")), inflateX: 10, inflateY: 8 },
      ],
    };
  },

  async "18-watchlist"(page) {
    const section = page.locator(".watchlist-section");
    const row = section.locator("tbody tr").first();
    return {
      region: section,
      targets: [
        { rect: box(section.locator(".panel-heading__aside")), inflateX: 10, inflateY: 8, badgeAngle: 180 },
        { rect: box(section.locator("thead .sort-button").first()), inflateX: 10, inflateY: 8, badgeAngle: 180 },
        { rect: box(row.locator(".watchlist-table__spark")), inflateX: 8, inflateY: 6 },
        { rect: box(row.locator(".watchlist-table__remove button")), inflateX: 8, inflateY: 8, badgeAngle: 45 },
      ],
    };
  },

  async "19-trade-history"(page) {
    const section = page.locator(".trade-history-section");
    const sale = section.locator("tbody tr").filter({ has: page.locator(".side-tag--sell") }).first();
    return {
      region: section,
      targets: [
        { rect: text(sale.locator("[data-label=Trade]")), inflateX: 8, inflateY: 6 },
        { rect: text(sale.locator("[data-label=Realized]")), inflateX: 8, inflateY: 6, badgeAngle: 270 },
        { rect: box(section.getByRole("link", { name: "Export every trade as CSV" })) },
        { rect: box(section.locator(".trade-history-toggle")), inflateX: 10, inflateY: 8 },
      ],
    };
  },
};

// --- Run -----------------------------------------------------------------------

await mkdir(OUT_DIR, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
try {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    viewport: VIEWPORT,
    deviceScaleFactor: 1.5,
    reducedMotion: "reduce",
  });
  // Same request as tests/e2e/support/api.ts loginAs(); the session cookie
  // lands in this context.
  const login = await context.request.post("/api/auth/demo-login", { data: { userId: DEMO_USER } });
  if (!login.ok()) throw new Error(`Demo login as ${DEMO_USER} failed with ${login.status()}: ${await login.text()}`);

  const page = await context.newPage();
  await openApp(page);

  for (const [name, setUp] of Object.entries(shots)) {
    if (ONLY && !ONLY.has(name)) continue;
    const shot = await setUp(page);
    await shoot(page, name, {
      regions: [shot.region, shot.extraRegion].filter(Boolean),
      targets: shot.targets,
      fullViewport: shot.fullViewport,
      keepScroll: shot.keepScroll,
    });
    if (shot.after) await shot.after();
    if (shot.reload) await openApp(page);
  }
} finally {
  await browser.close();
}
