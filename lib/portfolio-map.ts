import {
  hierarchy,
  treemap,
  treemapSquarify,
  type HierarchyNode,
  type HierarchyRectangularNode,
} from "d3-hierarchy";

import type { HoldingView } from "./contracts";

/**
 * Layout and colour for the portfolio map, a Finviz-style treemap of one
 * team's holdings: sector → industry → holding, with header strips naming
 * each sector and industry. Pure functions only, so the geometry can be
 * tested without a browser; the component just places what this returns.
 */

export type MapColorBy = "totalReturn" | "dayChange";
export type MapSizeBy = "marketValue" | "equal";

export interface PortfolioMapOptions {
  colorBy: MapColorBy;
  sizeBy: MapSizeBy;
  /** Cash gets its own neutral group when it is above zero. */
  includeCash: boolean;
}

export const DEFAULT_MAP_OPTIONS: PortfolioMapOptions = {
  colorBy: "totalReturn",
  sizeBy: "marketValue",
  includeCash: true,
};

export const CASH_GROUP_LABEL = "Cash";
export const CASH_TILE_KEY = "cash";

/** Pixel rectangle, top-left origin, rounded to whole pixels. */
export interface MapRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A sector or industry box; its header strip is drawn only when it fits. */
export interface MapGroupBox extends MapRect {
  key: string;
  label: string;
  /** Header strip height in pixels; zero when the box is too small for one. */
  headerHeight: number;
  isCash: boolean;
}

export interface MapTile extends MapRect {
  key: string;
  symbol: string;
  name: string;
  sector: string;
  industry: string;
  marketValueCents: number;
  /** The colour metric in percent; null for cash, which has no return. */
  percent: number | null;
  /** CSS background (tokens mixed with color-mix) and matching text colour. */
  background: string;
  color: string;
  /** Second line: the percent shown, or cash's amount. */
  detail: string;
  /** Symbol font size in pixels; zero hides the text on tiny tiles. */
  labelSize: number;
  /** Whether a second line (the percent, or cash's amount) fits under the label. */
  showDetail: boolean;
  isCash: boolean;
  holding: HoldingView | null;
  /** Cash only: where its label sits, in the space the holdings leave free. */
  labelRect?: MapRect;
}

export interface PortfolioMapLayout {
  width: number;
  height: number;
  /** The block the holdings fill, from the map's top-left corner. */
  holdingsArea: MapRect;
  sectors: MapGroupBox[];
  industries: MapGroupBox[];
  tiles: MapTile[];
}

/** Clamp range of each colour scale, in percent. */
export const MAP_COLOR_SCALE: Record<MapColorBy, number> = {
  dayChange: 3,
  totalReturn: 10,
};

/** Legend swatches, left to right, like Finviz's -3 … +3 strip. */
export const MAP_LEGEND_STEPS: Record<MapColorBy, number[]> = {
  dayChange: [-3, -2, -1, 0, 1, 2, 3],
  totalReturn: [-10, -6, -3, 0, 3, 6, 10],
};

// Header strips and gaps, in pixels. Gaps let the dark canvas show through
// as the borders between tiles, industries, and sectors.
const SECTOR_HEADER_PX = 17;
const INDUSTRY_HEADER_PX = 14;
const SECTOR_GAP_PX = 3;
const INDUSTRY_GAP_PX = 1;
const TILE_GAP_PX = 1;
// A box gets its header only when it stays usable after giving the strip up.
const MIN_HEADER_BOX_WIDTH_PX = 44;
const MIN_HEADER_BOX_HEIGHT_PX = 34;
// The smallest share of the map a holding may take, in square pixels: room
// for its symbol and percent. Early in a competition most of a team is still
// cash, and a true-to-scale first buy would be thinner than a pixel.
const MIN_HOLDING_AREA_PX = 90 * 64;
// The holdings block never shrinks below this, so its headers still fit.
const MIN_HOLDINGS_BLOCK_WIDTH_PX = 150;
const MIN_HOLDINGS_BLOCK_HEIGHT_PX = 110;
// Tile text sizing.
const MAX_LABEL_PX = 36;
const MIN_LABEL_PX = 9;

// Neutral is the app's muted grey: white text keeps at least 4.5:1 on it, on
// --red and --green, and on every oklab mix between them.
const NEUTRAL_COLOR = "var(--muted)";
const UP_COLOR = "var(--green)";
const DOWN_COLOR = "var(--red)";
const TILE_TEXT_COLOR = "#ffffff";
const CASH_BACKGROUND = "var(--hairline)";
const CASH_TEXT_COLOR = "var(--ink)";

/** Signed position on the colour scale: -1 full red, 0 neutral, 1 full green. */
export function mapColorIntensity(percent: number, colorBy: MapColorBy): number {
  if (!Number.isFinite(percent)) return 0;
  const scaled = percent / MAP_COLOR_SCALE[colorBy];
  // Normalise -0 so callers can compare with 0 safely.
  return Math.max(-1, Math.min(1, scaled)) || 0;
}

/** Background and text colour for a percent change on the chosen scale. */
export function mapTileColor(
  percent: number,
  colorBy: MapColorBy,
): { background: string; color: string } {
  const intensity = mapColorIntensity(percent, colorBy);
  const share = Math.round(Math.abs(intensity) * 100);
  if (share === 0) return { background: NEUTRAL_COLOR, color: TILE_TEXT_COLOR };
  const end = intensity > 0 ? UP_COLOR : DOWN_COLOR;
  if (share === 100) return { background: end, color: TILE_TEXT_COLOR };
  return {
    background: `color-mix(in oklab, ${end} ${share}%, ${NEUTRAL_COLOR})`,
    color: TILE_TEXT_COLOR,
  };
}

export const CASH_TILE_COLORS = { background: CASH_BACKGROUND, color: CASH_TEXT_COLOR };

/** The percent a tile shows and is coloured by. */
export function holdingMapPercent(holding: HoldingView, colorBy: MapColorBy): number {
  return colorBy === "dayChange" ? holding.dayChangePercent : holding.gainLossPercent;
}

/** "+1.23%" / "−0.40%", with a real minus sign like the rest of the app. */
export function formatMapPercent(value: number): string {
  const rounded = Math.abs(value) < 0.005 ? 0 : value;
  return `${rounded >= 0 ? "+" : "−"}${Math.abs(rounded).toFixed(2)}%`;
}

const cadFormat = new Intl.NumberFormat("en-CA", {
  style: "currency",
  currency: "CAD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// Text metrics in em of the label size: monospace glyphs run about 0.62em
// wide, the detail line is set at 0.62em, and lines are 1.05em tall.
const GLYPH_EM = 0.62;
const DETAIL_EM = 0.62;
const ONE_LINE_EM = 1.1;
const TWO_LINES_EM = 1.05 + 0.15 + DETAIL_EM * 1.05;

/**
 * Label font size for a tile and whether the detail line (the percent, or
 * cash's amount) fits under it. Two lines win when they fit at a readable
 * size without shrinking the label too far; then the label alone; on tiny
 * tiles, nothing (size zero).
 */
export function tileTextSize(
  width: number,
  height: number,
  label: string,
  detail: string,
): { labelSize: number; showDetail: boolean } {
  const room = width - 6;
  const labelWidth = room / (Math.max(label.length, 3) * GLYPH_EM);
  const detailWidth = room / (Math.max(detail.length, 1) * GLYPH_EM * DETAIL_EM);
  const twoLines = Math.min(MAX_LABEL_PX, labelWidth, detailWidth, (height - 4) / TWO_LINES_EM);
  const oneLine = Math.min(MAX_LABEL_PX, labelWidth, (height - 4) / ONE_LINE_EM);
  // A short, wide tile keeps a big symbol rather than two cramped lines.
  if (detail && twoLines >= MIN_LABEL_PX && twoLines >= oneLine * 0.6) {
    return { labelSize: Math.floor(twoLines), showDetail: true };
  }
  return oneLine >= MIN_LABEL_PX
    ? { labelSize: Math.floor(oneLine), showDetail: false }
    : { labelSize: 0, showDetail: false };
}

type MapDatum =
  | { kind: "root"; children: MapDatum[] }
  | { kind: "sector"; label: string; isCash: boolean; children: MapDatum[] }
  | { kind: "industry"; label: string; sector: string; isCash: boolean; children: MapDatum[] }
  | { kind: "holding"; holding: HoldingView; size: number }
  | { kind: "cash"; cashCents: number; size: number };

function groupKey(...parts: string[]): string {
  return parts.join("/");
}

function boxOf(
  node: HierarchyRectangularNode<MapDatum>,
  width: number,
  height: number,
): MapRect {
  // d3 collapses a box thinner than its padding to a line at its centre,
  // which can land a pixel past the edge; keep everything on the map.
  const clampX = (value: number) => Math.min(width, Math.max(0, Math.round(value)));
  const clampY = (value: number) => Math.min(height, Math.max(0, Math.round(value)));
  const x = clampX(node.x0);
  const y = clampY(node.y0);
  return {
    x,
    y,
    width: Math.max(0, clampX(node.x1) - x),
    height: Math.max(0, clampY(node.y1) - y),
  };
}

function buildTree(
  holdings: HoldingView[],
  cashCents: number,
  options: PortfolioMapOptions,
  minHoldingShare = 0,
): MapDatum {
  const sizeOf = (valueCents: number) =>
    options.sizeBy === "equal" ? 1 : Math.max(0, valueCents);
  // In value mode, a holding never drops below a readable floor; its hover
  // card and the list view still give its exact value and weight.
  const total =
    holdings.reduce((sum, holding) => sum + sizeOf(holding.marketValueCents), 0) +
    (options.includeCash ? sizeOf(cashCents) : 0);
  const minHoldingSize = options.sizeBy === "equal" ? 0 : total * minHoldingShare;
  const sectors = new Map<string, Map<string, MapDatum[]>>();

  for (const holding of holdings) {
    const value = sizeOf(holding.marketValueCents);
    // A position worth nothing has no area to draw; the list view keeps it.
    if (!(value > 0)) continue;
    const size = Math.max(value, minHoldingSize);
    const sector = holding.sector || "Unclassified";
    const industry = holding.industry || "Other";
    const industries = sectors.get(sector) ?? new Map<string, MapDatum[]>();
    sectors.set(sector, industries);
    const leaves = industries.get(industry) ?? [];
    industries.set(industry, leaves);
    leaves.push({ kind: "holding", holding, size });
  }

  const children: MapDatum[] = [...sectors].map(([sector, industries]) => ({
    kind: "sector",
    label: sector,
    isCash: false,
    children: [...industries].map(([industry, leaves]) => ({
      kind: "industry",
      label: industry,
      sector,
      isCash: false,
      children: leaves,
    })),
  }));

  if (options.includeCash && cashCents > 0) {
    children.push({
      kind: "sector",
      label: CASH_GROUP_LABEL,
      isCash: true,
      children: [
        {
          kind: "industry",
          label: CASH_GROUP_LABEL,
          sector: CASH_GROUP_LABEL,
          isCash: true,
          children: [{ kind: "cash", cashCents, size: sizeOf(cashCents) }],
        },
      ],
    });
  }

  return { kind: "root", children };
}

function leafSize(datum: MapDatum): number {
  return datum.kind === "holding" || datum.kind === "cash" ? datum.size : 0;
}

function datumLabel(datum: MapDatum): string {
  if (datum.kind === "holding") return datum.holding.symbol;
  if (datum.kind === "sector" || datum.kind === "industry") return datum.label;
  return "";
}

function sortNodes(a: HierarchyNode<MapDatum>, b: HierarchyNode<MapDatum>): number {
  // Cash always sits last; everything else is biggest first, then by name so
  // equal-size tiles keep a stable order between renders.
  const aCash = a.data.kind === "sector" && a.data.isCash;
  const bCash = b.data.kind === "sector" && b.data.isCash;
  if (aCash !== bCash) return aCash ? 1 : -1;
  return (b.value ?? 0) - (a.value ?? 0) || datumLabel(a.data).localeCompare(datumLabel(b.data));
}

/**
 * Lays the holdings out in a width × height box. Tile area is proportional
 * to CAD market value inside an industry (or equal in equal-size mode); the
 * header strips take a little area from each group, as on Finviz.
 */
/**
 * The map stands for the team's whole value. Holdings fill a block in the
 * top-left corner sized to the share that is invested, so a first small buy
 * draws as a small block rather than stretching across the map. Cash, when
 * shown, is the backdrop: everything the holdings leave free.
 */
function withHoldingsBlock(
  holdings: HoldingView[],
  cashCents: number,
  options: PortfolioMapOptions,
  width: number,
  height: number,
): PortfolioMapLayout {
  const cash = Math.max(0, cashCents);
  const holdingsValue = holdings.reduce(
    (sum, holding) => sum + Math.max(0, holding.marketValueCents),
    0,
  );
  const holdingCount = holdings.filter(
    (holding) => options.sizeBy === "equal" || holding.marketValueCents > 0,
  ).length;
  const investedShare = holdingsValue + cash > 0 ? holdingsValue / (holdingsValue + cash) : 1;
  // Enough room for every tile's floor, with space to spare for headers.
  const minShare = Math.min(
    1,
    Math.max(
      holdingCount * MIN_HOLDING_AREA_PX * 2,
      MIN_HOLDINGS_BLOCK_WIDTH_PX * MIN_HOLDINGS_BLOCK_HEIGHT_PX,
    ) /
      (width * height),
  );
  const scale = Math.sqrt(Math.min(1, Math.max(investedShare, minShare)));
  const blockWidth = Math.min(
    width,
    Math.max(Math.round(width * scale), MIN_HOLDINGS_BLOCK_WIDTH_PX),
  );
  const blockHeight = Math.min(
    height,
    Math.max(Math.round(height * scale), MIN_HOLDINGS_BLOCK_HEIGHT_PX),
  );
  const block = layoutTreemap(
    holdings,
    0,
    { ...options, includeCash: false },
    blockWidth,
    blockHeight,
  );
  const layout: PortfolioMapLayout = {
    ...block,
    width,
    height,
    holdingsArea: { x: 0, y: 0, width: blockWidth, height: blockHeight },
  };
  if (!options.includeCash || cash <= 0) return layout;

  // Cash's label goes in the larger of the two strips the block leaves free.
  const right: MapRect = {
    x: blockWidth + SECTOR_GAP_PX,
    y: 0,
    width: Math.max(0, width - blockWidth - SECTOR_GAP_PX),
    height,
  };
  const below: MapRect = {
    x: 0,
    y: blockHeight + SECTOR_GAP_PX,
    width,
    height: Math.max(0, height - blockHeight - SECTOR_GAP_PX),
  };
  const labelRect = right.width * right.height >= below.width * below.height ? right : below;
  const cashPercent = (cash / (cash + holdingsValue)) * 100;
  const detail = `${cadFormat.format(cash / 100)} · ${cashPercent.toFixed(1)}%`;
  const cashTile: MapTile = {
    x: 0,
    y: 0,
    width,
    height,
    key: CASH_TILE_KEY,
    symbol: CASH_GROUP_LABEL,
    name: "Cash (CAD)",
    sector: CASH_GROUP_LABEL,
    industry: CASH_GROUP_LABEL,
    marketValueCents: cash,
    percent: null,
    ...CASH_TILE_COLORS,
    detail,
    ...tileTextSize(labelRect.width, labelRect.height, CASH_GROUP_LABEL, detail),
    isCash: true,
    holding: null,
    labelRect,
  };
  // The backdrop comes first so every holding draws over it.
  return { ...layout, tiles: [cashTile, ...layout.tiles] };
}

export function layoutPortfolioMap(
  holdings: HoldingView[],
  cashCents: number,
  options: PortfolioMapOptions,
  width: number,
  height: number,
): PortfolioMapLayout {
  if (!(width > 0) || !(height > 0)) {
    return layoutTreemap(holdings, cashCents, options, width, height);
  }
  const hasHoldings = holdings.some(
    (holding) => options.sizeBy === "equal" || holding.marketValueCents > 0,
  );
  // With nothing invested, cash (if shown) is the whole map.
  if (!hasHoldings) return layoutTreemap(holdings, cashCents, options, width, height);
  return withHoldingsBlock(holdings, cashCents, options, width, height);
}

/** Squarified treemap of the given holdings (and cash) filling the box. */
function layoutTreemap(
  holdings: HoldingView[],
  cashCents: number,
  options: PortfolioMapOptions,
  width: number,
  height: number,
): PortfolioMapLayout {
  const empty: PortfolioMapLayout = {
    width: Math.max(0, width),
    height: Math.max(0, height),
    holdingsArea: { x: 0, y: 0, width: Math.max(0, width), height: Math.max(0, height) },
    sectors: [],
    industries: [],
    tiles: [],
  };
  if (!(width > 0) || !(height > 0)) return empty;

  const tree = buildTree(
    holdings,
    cashCents,
    options,
    Math.min(MIN_HOLDING_AREA_PX / (width * height), 0.25),
  );
  if (tree.kind !== "root" || tree.children.length === 0) return empty;

  const root = hierarchy<MapDatum>(tree, (datum) =>
    datum.kind === "root" || datum.kind === "sector" || datum.kind === "industry"
      ? datum.children
      : undefined,
  )
    .sum(leafSize)
    .sort(sortNodes);

  // d3 asks for a node's top padding after placing that node, so the header
  // can be dropped from boxes too small to hold one. Remember the answer.
  const headers = new Map<HierarchyNode<MapDatum>, number>();
  const headerFor = (node: HierarchyRectangularNode<MapDatum>): number => {
    const { data } = node;
    let header = 0;
    if (data.kind === "sector" || data.kind === "industry") {
      const fits =
        node.x1 - node.x0 >= MIN_HEADER_BOX_WIDTH_PX &&
        node.y1 - node.y0 >= MIN_HEADER_BOX_HEIGHT_PX;
      // The cash group is one tile: its sector strip says "Cash" already.
      const wanted =
        data.kind === "sector" ? SECTOR_HEADER_PX : data.isCash ? 0 : INDUSTRY_HEADER_PX;
      header = fits ? wanted : 0;
    }
    headers.set(node, header);
    return header;
  };
  const outerPadding = (node: HierarchyRectangularNode<MapDatum>) =>
    node.depth === 0 ? 0 : node.depth === 1 ? INDUSTRY_GAP_PX : TILE_GAP_PX;

  const laidOut = treemap<MapDatum>()
    .tile(treemapSquarify)
    .size([width, height])
    .paddingInner((node) =>
      node.depth === 0 ? SECTOR_GAP_PX : node.depth === 1 ? INDUSTRY_GAP_PX : TILE_GAP_PX,
    )
    .paddingTop((node) => headerFor(node) || outerPadding(node))
    .paddingRight(outerPadding)
    .paddingBottom(outerPadding)
    .paddingLeft(outerPadding)(root);

  const layout: PortfolioMapLayout = { ...empty, width, height };

  for (const node of laidOut.descendants()) {
    const { data } = node;
    const rect = boxOf(node, width, height);
    // Slivers thinner than the gaps between tiles have nothing to show.
    if (rect.width === 0 || rect.height === 0) continue;

    if (data.kind === "sector" || data.kind === "industry") {
      const box: MapGroupBox = {
        ...rect,
        key:
          data.kind === "sector"
            ? groupKey("sector", data.label)
            : groupKey("industry", data.sector, data.label),
        label: data.label,
        headerHeight: headers.get(node) ?? 0,
        isCash: data.isCash,
      };
      (data.kind === "sector" ? layout.sectors : layout.industries).push(box);
      continue;
    }

    if (data.kind === "holding") {
      const { holding } = data;
      const percent = holdingMapPercent(holding, options.colorBy);
      const detail = formatMapPercent(percent);
      layout.tiles.push({
        ...rect,
        key: groupKey("holding", holding.symbol),
        symbol: holding.symbol,
        name: holding.name,
        sector: holding.sector || "Unclassified",
        industry: holding.industry || "Other",
        marketValueCents: holding.marketValueCents,
        percent,
        ...mapTileColor(percent, options.colorBy),
        detail,
        ...tileTextSize(rect.width, rect.height, holding.symbol, detail),
        isCash: false,
        holding,
      });
    } else if (data.kind === "cash") {
      const detail = cadFormat.format(data.cashCents / 100);
      layout.tiles.push({
        ...rect,
        key: CASH_TILE_KEY,
        symbol: CASH_GROUP_LABEL,
        name: "Cash (CAD)",
        sector: CASH_GROUP_LABEL,
        industry: CASH_GROUP_LABEL,
        marketValueCents: data.cashCents,
        percent: null,
        ...CASH_TILE_COLORS,
        detail,
        ...tileTextSize(rect.width, rect.height, CASH_GROUP_LABEL, detail),
        isCash: true,
        holding: null,
      });
    }
  }

  return layout;
}
