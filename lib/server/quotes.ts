import type {
  AssetClass,
  InstrumentSearchResult,
  Quote,
  QuoteHistory,
  QuoteHistoryPoint,
  QuoteRange,
} from "../contracts";
import type { HistoricalMarketPrice } from "../backtest-contracts";
import { AppError } from "../errors";
import { lotExponentFromSize, lotSizeFromExponent } from "../lots";
import { MARKET_REFRESH_INTERVAL_MS } from "../market-config";
import { getDb } from "./db";

export const QUOTE_DELAY_MINUTES = 15;

const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const YAHOO_SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search";
const QUOTE_TTL_MS = MARKET_REFRESH_INTERVAL_MS;
const DAILY_HISTORY_TTL_MS = 15 * 60_000;
const INTRADAY_HISTORY_TTL_MS = MARKET_REFRESH_INTERVAL_MS;
const SEARCH_TTL_MS = 10 * 60_000;
const MARKET_DATA_TIMEOUT_MS = 8_000;
// Crypto pairs can carry a Yahoo disambiguation id, e.g. PEPE24478-USD.
export const MARKET_SYMBOL_PATTERN = /^[A-Z0-9.-]{1,24}$/;

const CRYPTO_EXCHANGE = "Crypto";
const CRYPTO_SECTOR = "Cryptocurrency";
/** A new crypto listing's lot is the smallest power of ten worth at least this. */
const MIN_LOT_VALUE_CAD = 10;
const MIN_LOT_EXPONENT = -12;
const MAX_LOT_EXPONENT = 15;
const DEFAULT_CRYPTO_MIN_VOLUME = 250_000;
const CRYPTO_MAX_QUOTE_AGE_MS = 10 * 60_000;
/** Five-minute bars in the last day; 48 is four hours of real trading. */
const CRYPTO_MIN_HISTORY_POINTS = 48;
/** Last-known crypto prices are written to the database at most this often. */
const LAST_PRICE_PERSIST_INTERVAL_MS = 10 * 60_000;

/** ETFs are searchable and buyable only when LUBAN_ENABLE_ETFS=true. */
export function isEtfTradingEnabled(): boolean {
  return process.env.LUBAN_ENABLE_ETFS?.trim().toLowerCase() === "true";
}

/** Crypto is searchable and buyable only when LUBAN_ENABLE_CRYPTO=true. */
export function isCryptoTradingEnabled(): boolean {
  return process.env.LUBAN_ENABLE_CRYPTO?.trim().toLowerCase() === "true";
}

export function isAssetClassEnabled(assetClass: AssetClass | undefined): boolean {
  if (assetClass === "ETF") return isEtfTradingEnabled();
  if (assetClass === "CRYPTO") return isCryptoTradingEnabled();
  return true;
}

/**
 * Comma-separated symbols a host has pulled from the simulator
 * (LUBAN_BLOCKED_SYMBOLS). Blocked symbols cannot be found or bought;
 * existing holdings can still be sold.
 */
export function isSymbolBlocked(symbol: string): boolean {
  const raw = process.env.LUBAN_BLOCKED_SYMBOLS;
  if (!raw) return false;
  const normalized = normalizeMarketSymbol(symbol);
  // Blocking either pair of a coin blocks the coin: BTC-CAD also blocks BTC-USD.
  const coin = cryptoPairBase(normalized);
  return raw.split(",").some((entry) => {
    if (!entry.trim()) return false;
    const blocked = normalizeMarketSymbol(entry);
    return blocked === normalized || (coin !== null && cryptoPairBase(blocked) === coin);
  });
}

function cryptoPairBase(symbol: string): string | null {
  const match = symbol.match(/^(.+)-(?:CAD|USD)$/);
  return match ? match[1] : null;
}

function cryptoMinVolume(): number {
  const raw = Number(process.env.LUBAN_CRYPTO_MIN_VOLUME);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_CRYPTO_MIN_VOLUME;
}

const YAHOO_EXCHANGES: Record<
  string,
  { exchange: string; listingCurrency: "CAD" | "USD" }
> = {
  NMS: { exchange: "NASDAQ", listingCurrency: "USD" },
  NGM: { exchange: "NASDAQ", listingCurrency: "USD" },
  NCM: { exchange: "NASDAQ", listingCurrency: "USD" },
  NAS: { exchange: "NASDAQ", listingCurrency: "USD" },
  NASDAQ: { exchange: "NASDAQ", listingCurrency: "USD" },
  NYQ: { exchange: "NYSE", listingCurrency: "USD" },
  NYSE: { exchange: "NYSE", listingCurrency: "USD" },
  ASE: { exchange: "NYSE American", listingCurrency: "USD" },
  PCX: { exchange: "NYSE Arca", listingCurrency: "USD" },
  TOR: { exchange: "TSX", listingCurrency: "CAD" },
  TSX: { exchange: "TSX", listingCurrency: "CAD" },
  BTS: { exchange: "Cboe BZX", listingCurrency: "USD" },
};

export const QUOTE_RANGES = ["1D", "5D", "1M", "3M"] as const;

interface QuoteRangeConfig {
  providerRange: string;
  interval: string;
  testPointCount: number;
  testStepMs: number;
}

export const QUOTE_RANGE_CONFIG: Record<QuoteRange, QuoteRangeConfig> = {
  "1D": {
    providerRange: "1d",
    interval: "5m",
    testPointCount: 48,
    testStepMs: 5 * 60_000,
  },
  "5D": {
    providerRange: "5d",
    interval: "15m",
    testPointCount: 80,
    testStepMs: 30 * 60_000,
  },
  "1M": {
    providerRange: "1mo",
    interval: "1d",
    testPointCount: 22,
    testStepMs: 24 * 60 * 60_000,
  },
  "3M": {
    providerRange: "3mo",
    interval: "1d",
    testPointCount: 66,
    testStepMs: 24 * 60 * 60_000,
  },
};

export interface MarketInstrument {
  symbol: string;
  name: string;
  exchange: string;
  sector: string;
  listingCurrency: "CAD" | "USD";
  basePriceCents: number;
  previousCloseCents: number;
  fxRateBasisPoints: number;
  /** Missing means STOCK. */
  assetClass?: AssetClass;
  /**
   * Crypto lot size as a power of ten. Null only while a new crypto listing
   * is being discovered, before its first price fixes the lot.
   */
  lotExponent?: number | null;
  /** Last good per-lot price (listing currency), when one was recorded. */
  lastPriceCents?: number | null;
  lastPricedAt?: string | null;
}

/**
 * Network-backed providers populate their cache before database transactions.
 * The synchronous quote method only reads that cache.
 */
export interface MarketDataProvider {
  readonly id: string;
  /**
   * The provider's clock in epoch milliseconds. Order checks that compare
   * quote timestamps and session bounds use it so an injected test clock and
   * the quote it produced always agree.
   */
  now?(): number;
  quote(instrument: MarketInstrument, at: Date): Quote;
  refreshQuote?(instrument: MarketInstrument, at: Date): Promise<Quote>;
  search?(query: string): Promise<InstrumentSearchResult[]>;
  resolveInstrument?(symbol: string): Promise<InstrumentSearchResult | null>;
  history?(
    instrument: MarketInstrument,
    range: QuoteRange,
    at: Date,
  ): Promise<QuoteHistory>;
  historicalPrice?(
    instrument: MarketInstrument,
    requestedDate: string,
    at: Date,
  ): Promise<HistoricalMarketPrice>;
  splitMultipliers?(
    instrument: MarketInstrument,
    sessionDates: string[],
    at: Date,
  ): Promise<Map<string, number>>;
}

interface InstrumentRow {
  symbol: string;
  name: string;
  exchange: string;
  sector: string;
  listing_currency: "CAD" | "USD";
  base_price_cents: number;
  previous_close_cents: number;
  fx_rate_basis_points: number;
  asset_class: AssetClass | null;
  lot_exponent: number | null;
  last_price_cents: number | null;
  last_priced_at: string | null;
}

const INSTRUMENT_COLUMNS = `
  symbol, name, exchange, sector, listing_currency,
  base_price_cents, previous_close_cents, fx_rate_basis_points,
  asset_class, lot_exponent, last_price_cents, last_priced_at`;

interface YahooChartMeta {
  currency?: unknown;
  symbol?: unknown;
  exchangeName?: unknown;
  instrumentType?: unknown;
  regularMarketTime?: unknown;
  regularMarketPrice?: unknown;
  regularMarketVolume?: unknown;
  chartPreviousClose?: unknown;
  previousClose?: unknown;
  exchangeTimezoneName?: unknown;
  dataGranularity?: unknown;
  currentTradingPeriod?: unknown;
  marketState?: unknown;
}

interface YahooIndicatorQuote {
  open?: unknown;
  high?: unknown;
  low?: unknown;
  close?: unknown;
  volume?: unknown;
}

interface YahooChartResult {
  meta?: YahooChartMeta;
  timestamp?: unknown;
  indicators?: { quote?: unknown };
  events?: { splits?: unknown };
}

interface YahooChartPayload {
  chart?: { result?: unknown; error?: unknown };
}

interface YahooSearchQuote {
  symbol?: unknown;
  longname?: unknown;
  shortname?: unknown;
  exchange?: unknown;
  quoteType?: unknown;
  sector?: unknown;
}

interface YahooSearchPayload {
  quotes?: unknown;
}

interface ParsedYahooChart {
  meta: YahooChartMeta;
  timestamps: Array<number | null>;
  quote: YahooIndicatorQuote;
  splits: YahooSplitEvent[];
}

interface YahooSplitEvent {
  date: number;
  numerator: number;
  denominator: number;
}

interface CacheEntry<T> {
  value: T;
  fetchedAtMs: number;
}

interface FailedQuoteRefresh {
  error: AppError;
  attemptedAtMs: number;
}

interface YahooMarketState {
  quotes: Map<string, CacheEntry<Quote>>;
  histories: Map<string, CacheEntry<QuoteHistory>>;
  historicalPrices: Map<string, CacheEntry<HistoricalMarketPrice>>;
  splitMultipliers: Map<string, CacheEntry<Map<string, number>>>;
  searches: Map<string, CacheEntry<InstrumentSearchResult[]>>;
  discoveredInstruments: Map<string, InstrumentSearchResult>;
  quoteFailures: Map<string, FailedQuoteRefresh>;
  searchFailures: Map<string, FailedQuoteRefresh>;
  inFlight: Map<string, Promise<unknown>>;
}

const yahooGlobal = globalThis as typeof globalThis & {
  __lubanYahooMarketState?: YahooMarketState;
};

/**
 * Every provider cache is keyed partly by user input (search text, symbols,
 * dates), so each map is capped. Map preserves insertion order; re-inserting
 * on write keeps recently refreshed entries and evicts the oldest first.
 */
const MAX_CACHE_ENTRIES = 2_000;

let quoteGeneration = 0;

/** Changes whenever a cached quote is written; lets callers memoize valuations. */
export function quoteCacheGeneration(): number {
  return quoteGeneration;
}

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_CACHE_ENTRIES) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

function yahooState(): YahooMarketState {
  if (!yahooGlobal.__lubanYahooMarketState) {
    yahooGlobal.__lubanYahooMarketState = {
      quotes: new Map(),
      histories: new Map(),
      historicalPrices: new Map(),
      splitMultipliers: new Map(),
      searches: new Map(),
      discoveredInstruments: new Map(),
      quoteFailures: new Map(),
      searchFailures: new Map(),
      inFlight: new Map(),
    };
  }
  yahooGlobal.__lubanYahooMarketState.searches ??= new Map();
  yahooGlobal.__lubanYahooMarketState.historicalPrices ??= new Map();
  yahooGlobal.__lubanYahooMarketState.splitMultipliers ??= new Map();
  yahooGlobal.__lubanYahooMarketState.discoveredInstruments ??= new Map();
  yahooGlobal.__lubanYahooMarketState.quoteFailures ??= new Map();
  yahooGlobal.__lubanYahooMarketState.searchFailures ??= new Map();
  return yahooGlobal.__lubanYahooMarketState;
}

function rowToInstrument(row: InstrumentRow): MarketInstrument {
  return {
    symbol: row.symbol,
    name: row.name,
    exchange: row.exchange,
    sector: row.sector,
    listingCurrency: row.listing_currency,
    basePriceCents: Number(row.base_price_cents),
    previousCloseCents: Number(row.previous_close_cents),
    fxRateBasisPoints: Number(row.fx_rate_basis_points),
    assetClass: row.asset_class ?? "STOCK",
    lotExponent: Number(row.lot_exponent ?? 0),
    lastPriceCents:
      row.last_price_cents === null || row.last_price_cents === undefined
        ? null
        : Number(row.last_price_cents),
    lastPricedAt: row.last_priced_at ?? null,
  };
}

function instrumentAssetClass(instrument: MarketInstrument): AssetClass {
  return instrument.assetClass ?? "STOCK";
}

/** Multiply by 10^exponent without float drift on negative exponents. */
function scaleByPowerOfTen(value: number, exponent: number): number {
  return exponent >= 0 ? value * 10 ** exponent : value / 10 ** -exponent;
}

/**
 * Lot exponent for a newly listed crypto pair: the smallest power of ten
 * whose lot is worth at least MIN_LOT_VALUE_CAD. Fixed forever after listing,
 * because holdings are counted in lots.
 */
export function cryptoLotExponent(tokenPriceCad: number): number {
  if (!Number.isFinite(tokenPriceCad) || tokenPriceCad <= 0) {
    throw new AppError(
      "ASSET_NOT_TRADABLE",
      "This crypto pair has no usable price.",
      422,
    );
  }
  // "+ 0" turns Math.ceil's -0 (for a token worth exactly $10) into 0.
  const exponent = Math.ceil(Math.log10(MIN_LOT_VALUE_CAD / tokenPriceCad) - 1e-9) + 0;
  if (exponent < MIN_LOT_EXPONENT || exponent > MAX_LOT_EXPONENT) {
    throw new AppError(
      "ASSET_NOT_TRADABLE",
      "This crypto pair's price is outside the range the simulator supports.",
      422,
    );
  }
  return exponent;
}

/**
 * Data-quality checks every crypto quote must pass before it can trade:
 * a fresh price, real trading volume, and a full-enough recent history.
 * Returns a plain-language problem, or null when the pair looks healthy.
 */
export function cryptoQualityProblem(
  meta: { regularMarketTime?: unknown; regularMarketVolume?: unknown },
  closes: Array<number | null>,
  nowMs: number,
): string | null {
  const marketTime = finiteNumber(meta.regularMarketTime);
  if (marketTime === null || nowMs - marketTime * 1_000 > CRYPTO_MAX_QUOTE_AGE_MS) {
    return "its price has not updated in the last 10 minutes";
  }
  const volume = finiteNumber(meta.regularMarketVolume);
  if (volume === null || volume < cryptoMinVolume()) {
    return "it does not have enough trading volume";
  }
  if (closes.filter((value) => value !== null).length < CRYPTO_MIN_HISTORY_POINTS) {
    return "it does not have enough recent price history";
  }
  return null;
}

const ALWAYS_OPEN_SESSION = {
  marketOpen: true,
  marketClosesAt: null,
  marketOpensAt: null,
} as const;

function hashString(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function pseudoRandom(seed: number): number {
  let value = seed >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (value >>> 0) / 4_294_967_295;
}

function roundPercent(numerator: number, denominator: number): number {
  return denominator === 0
    ? 0
    : Math.round((numerator / denominator) * 10_000) / 100;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberArray(value: unknown): Array<number | null> {
  return Array.isArray(value) ? value.map((item) => finiteNumber(item)) : [];
}

function parseSplitEvents(value: unknown): YahooSplitEvent[] {
  if (!value || typeof value !== "object") return [];

  return Object.values(value as Record<string, unknown>).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const raw = candidate as Record<string, unknown>;
    const date = finiteNumber(raw.date);
    const numerator = finiteNumber(raw.numerator);
    const denominator = finiteNumber(raw.denominator);
    if (
      date === null ||
      numerator === null ||
      denominator === null ||
      numerator <= 0 ||
      denominator <= 0
    ) {
      return [];
    }
    return [{ date, numerator, denominator }];
  });
}

function calendarDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseHistoricalDate(value: string, at: Date): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError(
      "INVALID_HISTORICAL_DATE",
      "Purchase date must use YYYY-MM-DD.",
      400,
      { field: "purchaseDate" },
    );
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new AppError(
      "INVALID_HISTORICAL_DATE",
      "Purchase date is not a valid calendar date.",
      400,
      { field: "purchaseDate" },
    );
  }
  const today = calendarDateInTimeZone(at, "America/Toronto");
  if (value >= today) {
    throw new AppError(
      "HISTORICAL_DATE_REQUIRED",
      "Choose a completed market date before today.",
      400,
      { field: "purchaseDate", maximum: today },
    );
  }
  return parsed;
}

interface HistoricalClosePoint {
  sessionDate: string;
  sessionAt: string;
  closeCents: number;
  closeBasisPoints: number;
}

function selectHistoricalClose(
  chart: ParsedYahooChart,
  requestedDate: string,
): HistoricalClosePoint {
  const closes = numberArray(chart.quote.close);
  const timeZone =
    typeof chart.meta.exchangeTimezoneName === "string"
      ? chart.meta.exchangeTimezoneName
      : "America/Toronto";
  let selected: HistoricalClosePoint | null = null;

  for (let index = 0; index < chart.timestamps.length; index += 1) {
    const timestamp = chart.timestamps[index] ?? null;
    const close = closes[index] ?? null;
    if (timestamp === null || close === null || close <= 0) continue;
    const at = new Date(timestamp * 1_000);
    const sessionDate = calendarDateInTimeZone(at, timeZone);
    if (sessionDate > requestedDate) continue;
    if (!selected || Date.parse(at.toISOString()) > Date.parse(selected.sessionAt)) {
      selected = {
        sessionDate,
        sessionAt: at.toISOString(),
        closeCents: Math.round(close * 100),
        closeBasisPoints: Math.round(close * 10_000),
      };
    }
  }

  if (!selected) {
    throw new AppError(
      "HISTORICAL_PRICE_UNAVAILABLE",
      "No completed market close was available on or before that date.",
      404,
      { requestedDate },
    );
  }

  const gapDays = Math.round(
    (Date.parse(`${requestedDate}T00:00:00.000Z`) -
      Date.parse(`${selected.sessionDate}T00:00:00.000Z`)) /
      86_400_000,
  );
  if (gapDays > 7) {
    throw new AppError(
      "HISTORICAL_PRICE_UNAVAILABLE",
      "No nearby trading session was available for that date.",
      404,
      { requestedDate },
    );
  }

  return selected;
}

function splitMultiplierAfter(
  chart: ParsedYahooChart,
  sessionDate: string,
  at: Date,
): number {
  const timeZone =
    typeof chart.meta.exchangeTimezoneName === "string"
      ? chart.meta.exchangeTimezoneName
      : "America/Toronto";
  let multiplier = 1;

  for (const split of chart.splits) {
    const splitAt = new Date(split.date * 1_000);
    const splitDate = calendarDateInTimeZone(splitAt, timeZone);
    if (splitDate <= sessionDate || splitAt.getTime() > at.getTime()) continue;
    multiplier *= split.numerator / split.denominator;
  }

  if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 1_000_000) {
    throw new AppError(
      "MARKET_DATA_INVALID",
      "The historical split data was invalid.",
      503,
    );
  }
  return Math.round(multiplier * 1_000_000) / 1_000_000;
}

export function normalizeMarketSymbol(value: string): string {
  const symbol = value.trim().toUpperCase();
  const tsxClassShare = symbol.match(/^([A-Z0-9]+)\.([A-Z])\.TO$/);
  if (tsxClassShare) return `${tsxClassShare[1]}-${tsxClassShare[2]}.TO`;
  const usClassShare = symbol.match(/^([A-Z0-9]+)\.([A-Z])$/);
  if (usClassShare) return `${usClassShare[1]}-${usClassShare[2]}`;
  return symbol;
}

function yahooSearchQuery(value: string): string {
  const trimmed = value.trim();
  const normalizedSymbol = normalizeMarketSymbol(trimmed);
  return MARKET_SYMBOL_PATTERN.test(normalizedSymbol)
    ? normalizedSymbol
    : trimmed;
}

function tsxAliasForBareTickerQuery(value: string): string | null {
  const normalized = normalizeMarketSymbol(value);
  if (
    !MARKET_SYMBOL_PATTERN.test(normalized) ||
    normalized.endsWith(".TO") ||
    normalized.length > 6
  ) {
    return null;
  }

  const alias = `${normalized}.TO`;
  return MARKET_SYMBOL_PATTERN.test(alias) ? alias : null;
}

function isExplicitDerivativeSecurity(symbol: string, name: string): boolean {
  return (
    /-(?:WT|WTS|WS|RT|R|U)$/.test(symbol) ||
    /\b(?:warrants?|rights?)\b/i.test(name) ||
    /\bunits?(?:,|\s+(?:each|consisting|comprised)|$)/i.test(name)
  );
}

/**
 * Leveraged and inverse ETFs are excluded: the simulator deliberately has no
 * leverage or short selling, and these funds are those strategies in a wrapper.
 */
function isLeveragedOrInverseFund(name: string): boolean {
  return (
    /\b[1-9](?:\.\d+)?x\b/i.test(name) ||
    /\b(?:ultra|ultrapro|ultrashort|leveraged|inverse|bear)\b/i.test(name) ||
    /\bshort\b(?![- ](?:term|duration|maturity))/i.test(name)
  );
}

function cryptoPairCurrency(symbol: string): "CAD" | "USD" | null {
  if (symbol.endsWith("-CAD")) return "CAD";
  if (symbol.endsWith("-USD")) return "USD";
  return null;
}

/** "Bitcoin USD" becomes "Bitcoin". */
function cryptoDisplayName(name: string, currency: "CAD" | "USD"): string {
  const suffix = ` ${currency}`;
  return name.endsWith(suffix) ? name.slice(0, -suffix.length).trim() || name : name;
}

function parseYahooSearch(payload: unknown): InstrumentSearchResult[] {
  const rawQuotes = (payload as YahooSearchPayload | null)?.quotes;
  if (!Array.isArray(rawQuotes)) {
    throw new AppError(
      "MARKET_DATA_INVALID",
      "The market symbol search returned an incomplete response.",
      503,
    );
  }

  const results = new Map<string, InstrumentSearchResult>();
  const cryptoPairs = new Map<string, InstrumentSearchResult>();
  for (const rawQuote of rawQuotes) {
    if (!rawQuote || typeof rawQuote !== "object") continue;
    const quote = rawQuote as YahooSearchQuote;
    const symbol =
      typeof quote.symbol === "string"
        ? normalizeMarketSymbol(quote.symbol)
        : "";
    if (!MARKET_SYMBOL_PATTERN.test(symbol) || isSymbolBlocked(symbol)) continue;
    const longName = typeof quote.longname === "string" ? quote.longname.trim() : "";
    const shortName =
      typeof quote.shortname === "string" ? quote.shortname.trim() : "";
    const name = longName || shortName || symbol;

    if (quote.quoteType === "CRYPTOCURRENCY") {
      const currency = cryptoPairCurrency(symbol);
      if (!isCryptoTradingEnabled() || !currency) continue;
      // One row per coin: prefer the CAD pair, which needs no conversion.
      const base = symbol.slice(0, -4);
      const existing = cryptoPairs.get(base);
      if (existing && existing.listingCurrency === "CAD") continue;
      cryptoPairs.set(base, {
        symbol,
        name: cryptoDisplayName(name, currency),
        exchange: CRYPTO_EXCHANGE,
        sector: CRYPTO_SECTOR,
        listingCurrency: currency,
        assetClass: "CRYPTO",
      });
      continue;
    }

    const assetClass: AssetClass | null =
      quote.quoteType === "EQUITY"
        ? "STOCK"
        : quote.quoteType === "ETF" && isEtfTradingEnabled()
          ? "ETF"
          : null;
    if (!assetClass || typeof quote.exchange !== "string") continue;

    const market = YAHOO_EXCHANGES[quote.exchange];
    if (!market) continue;
    if (isExplicitDerivativeSecurity(symbol, name)) continue;
    if (assetClass === "ETF" && isLeveragedOrInverseFund(name)) continue;

    const sector =
      typeof quote.sector === "string" && quote.sector.trim()
        ? quote.sector.trim()
        : "Unclassified";
    if (!results.has(symbol)) {
      results.set(symbol, {
        symbol,
        name,
        exchange: market.exchange,
        sector: assetClass === "ETF" && sector === "Unclassified" ? "ETF" : sector,
        listingCurrency: market.listingCurrency,
        assetClass,
      });
    }
  }
  for (const pair of cryptoPairs.values()) {
    if (!results.has(pair.symbol)) results.set(pair.symbol, pair);
  }
  return [...results.values()];
}

function sourceUrl(symbol: string): string {
  return `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`;
}

function validateYahooInstrument(
  instrument: MarketInstrument,
  chart: ParsedYahooChart,
): void {
  const chartSymbol =
    typeof chart.meta.symbol === "string"
      ? normalizeMarketSymbol(chart.meta.symbol)
      : null;
  const exchangeCode =
    typeof chart.meta.exchangeName === "string" ? chart.meta.exchangeName : null;
  const market = exchangeCode ? YAHOO_EXCHANGES[exchangeCode] : null;
  const currency =
    typeof chart.meta.currency === "string" ? chart.meta.currency : null;
  const instrumentType =
    typeof chart.meta.instrumentType === "string"
      ? chart.meta.instrumentType
      : null;

  if (instrumentAssetClass(instrument) === "CRYPTO") {
    if (
      (chartSymbol && chartSymbol !== instrument.symbol) ||
      instrumentType !== "CRYPTOCURRENCY" ||
      (currency && currency !== instrument.listingCurrency)
    ) {
      throw new AppError(
        "MARKET_DATA_INVALID",
        `${instrument.symbol} is not a supported crypto pair.`,
        503,
      );
    }
    return;
  }

  if (
    (chartSymbol && chartSymbol !== instrument.symbol) ||
    (instrumentType && instrumentType !== "EQUITY" && instrumentType !== "ETF") ||
    (exchangeCode && !market) ||
    (market && market.exchange !== instrument.exchange) ||
    (market && market.listingCurrency !== instrument.listingCurrency) ||
    (currency && currency !== instrument.listingCurrency)
  ) {
    throw new AppError(
      "MARKET_DATA_INVALID",
      `${instrument.symbol} is not a stock or ETF on an exchange the simulator supports.`,
      503,
    );
  }
}

function normalizeProviderError(error: unknown, context: string): AppError {
  if (error instanceof AppError) return error;
  const timedOut =
    error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError");
  return new AppError(
    timedOut ? "MARKET_DATA_TIMEOUT" : "MARKET_DATA_UNAVAILABLE",
    timedOut
      ? `${context} timed out. Try again in a moment.`
      : `${context} is temporarily unavailable. Try again in a moment.`,
    503,
  );
}

function parseYahooChart(payload: unknown, symbol: string): ParsedYahooChart {
  const chart = (payload as YahooChartPayload | null)?.chart;
  const result = Array.isArray(chart?.result) ? chart.result[0] : null;
  if (!result || typeof result !== "object") {
    throw new AppError(
      "MARKET_DATA_INVALID",
      `The market data response for ${symbol} did not contain a chart.`,
      503,
    );
  }

  const typedResult = result as YahooChartResult;
  const timestamps = numberArray(typedResult.timestamp);
  const quoteList = Array.isArray(typedResult.indicators?.quote)
    ? typedResult.indicators.quote
    : [];
  const quote = quoteList[0];
  if (!typedResult.meta || !quote || typeof quote !== "object") {
    throw new AppError(
      "MARKET_DATA_INVALID",
      `The market data response for ${symbol} was incomplete.`,
      503,
    );
  }

  return {
    meta: typedResult.meta,
    timestamps,
    quote: quote as YahooIndicatorQuote,
    splits: parseSplitEvents(typedResult.events?.splits),
  };
}

export interface MarketSession {
  marketOpen: boolean;
  marketClosesAt: string | null;
  marketOpensAt: string | null;
}

/**
 * Derive whether the regular session is open from Yahoo chart metadata.
 * `currentTradingPeriod.regular` carries unix-second bounds; `marketState`,
 * when Yahoo includes it, must also say REGULAR. Anything missing or
 * malformed fails closed so orders never fill against an unknown session.
 */
export function marketSessionFromYahooMeta(
  meta: YahooChartMeta,
  nowMs: number,
): MarketSession {
  const closed: MarketSession = {
    marketOpen: false,
    marketClosesAt: null,
    marketOpensAt: null,
  };
  const period =
    meta.currentTradingPeriod && typeof meta.currentTradingPeriod === "object"
      ? (meta.currentTradingPeriod as { regular?: unknown }).regular
      : null;
  if (!period || typeof period !== "object") return closed;
  const start = finiteNumber((period as { start?: unknown }).start);
  const end = finiteNumber((period as { end?: unknown }).end);
  if (start === null || end === null || start <= 0 || end <= start) {
    return closed;
  }

  const startMs = start * 1_000;
  const endMs = end * 1_000;
  const upcomingOpen =
    startMs > nowMs ? new Date(startMs).toISOString() : null;
  if (
    meta.marketState !== undefined &&
    meta.marketState !== null &&
    meta.marketState !== "REGULAR"
  ) {
    return { ...closed, marketOpensAt: upcomingOpen };
  }
  if (nowMs < startMs || nowMs >= endMs) {
    return { ...closed, marketOpensAt: upcomingOpen };
  }

  return {
    marketOpen: true,
    marketClosesAt: new Date(endMs).toISOString(),
    marketOpensAt: new Date(startMs).toISOString(),
  };
}

function quoteFromYahooChart(
  instrument: MarketInstrument,
  chart: ParsedYahooChart,
  fxRateBasisPoints: number,
  nowMs: number,
  lotExponent = 0,
): Quote {
  const closes = numberArray(chart.quote.close);
  const lastClose = [...closes].reverse().find((value) => value !== null) ?? null;
  const marketPrice = finiteNumber(chart.meta.regularMarketPrice) ?? lastClose;
  const previousClose =
    finiteNumber(chart.meta.chartPreviousClose) ??
    finiteNumber(chart.meta.previousClose);
  const quoteTimestamp =
    finiteNumber(chart.meta.regularMarketTime) ??
    [...chart.timestamps].reverse().find((value) => value !== null) ??
    null;

  if (marketPrice === null || previousClose === null || quoteTimestamp === null) {
    throw new AppError(
      "MARKET_DATA_INVALID",
      `The market quote for ${instrument.symbol} was incomplete.`,
      503,
    );
  }

  const isCrypto = instrumentAssetClass(instrument) === "CRYPTO";
  // Yahoo's search sometimes labels a fund as an equity; the chart's own
  // type decides, so an ETF can never trade as a stock while ETFs are off.
  const assetClass: AssetClass = isCrypto
    ? "CRYPTO"
    : chart.meta.instrumentType === "ETF"
      ? "ETF"
      : "STOCK";
  // Crypto prices are per lot. A lot that rounds below one cent is held at
  // one cent so the ledger never sees a zero price; buys are refused then.
  const priceCents = Math.max(
    isCrypto ? 1 : 0,
    Math.round(scaleByPowerOfTen(marketPrice, lotExponent) * 100),
  );
  const previousCloseCents = Math.max(
    isCrypto ? 1 : 0,
    Math.round(scaleByPowerOfTen(previousClose, lotExponent) * 100),
  );
  const priceCadCents = Math.round((priceCents * fxRateBasisPoints) / 10_000);
  const previousCloseCadCents = Math.round(
    (previousCloseCents * fxRateBasisPoints) / 10_000,
  );
  const changeCents = priceCents - previousCloseCents;
  const qualityProblem = isCrypto
    ? cryptoQualityProblem(chart.meta, numberArray(chart.quote.close), nowMs)
    : null;

  return {
    symbol: instrument.symbol,
    name: instrument.name,
    exchange: instrument.exchange,
    sector: instrument.sector,
    listingCurrency: instrument.listingCurrency,
    priceCents,
    priceCadCents,
    previousCloseCents,
    previousCloseCadCents,
    changeCents,
    changePercent: roundPercent(changeCents, previousCloseCents),
    fxRateBasisPoints,
    asOf: new Date(quoteTimestamp * 1_000).toISOString(),
    source: "YAHOO_FINANCE",
    sourceUrl: sourceUrl(instrument.symbol),
    isStale: false,
    ...(isCrypto ? ALWAYS_OPEN_SESSION : marketSessionFromYahooMeta(chart.meta, nowMs)),
    assetClass,
    lotSize: lotSizeFromExponent(lotExponent),
    tradingHaltReason: qualityProblem
      ? `Trading in ${instrument.symbol} is paused because ${qualityProblem}.`
      : null,
  };
}

function historyFromYahooChart(
  instrument: MarketInstrument,
  range: QuoteRange,
  chart: ParsedYahooChart,
  fetchedAt: Date,
): QuoteHistory {
  // Charts use the same per-lot prices as quotes and orders.
  const lotExponent = instrument.lotExponent ?? 0;
  const toCents = (value: number) =>
    Math.round(scaleByPowerOfTen(value, lotExponent) * 100);
  const opens = numberArray(chart.quote.open);
  const highs = numberArray(chart.quote.high);
  const lows = numberArray(chart.quote.low);
  const closes = numberArray(chart.quote.close);
  const volumes = numberArray(chart.quote.volume);
  const unique = new Map<string, QuoteHistoryPoint>();

  for (let index = 0; index < chart.timestamps.length; index += 1) {
    const timestamp = chart.timestamps[index] ?? null;
    const close = closes[index] ?? null;
    if (timestamp === null || close === null) continue;
    const at = new Date(timestamp * 1_000).toISOString();
    const open = opens[index] ?? null;
    const high = highs[index] ?? null;
    const low = lows[index] ?? null;
    const volume = volumes[index] ?? null;
    unique.set(at, {
      at,
      openCents: open === null ? null : toCents(open),
      highCents: high === null ? null : toCents(high),
      lowCents: low === null ? null : toCents(low),
      closeCents: toCents(close),
      volume: volume === null ? null : Math.round(volume),
    });
  }

  const points = [...unique.values()].sort(
    (left, right) => Date.parse(left.at) - Date.parse(right.at),
  );
  if (points.length === 0) {
    throw new AppError(
      "MARKET_HISTORY_UNAVAILABLE",
      `No market history is currently available for ${instrument.symbol}.`,
      503,
    );
  }

  return {
    symbol: instrument.symbol,
    range,
    interval:
      typeof chart.meta.dataGranularity === "string"
        ? chart.meta.dataGranularity
        : QUOTE_RANGE_CONFIG[range].interval,
    listingCurrency: instrument.listingCurrency,
    exchangeTimeZone:
      instrumentAssetClass(instrument) === "CRYPTO"
        ? "America/Toronto"
        : typeof chart.meta.exchangeTimezoneName === "string"
          ? chart.meta.exchangeTimezoneName
          : "America/Toronto",
    points,
    asOf: points.at(-1)!.at,
    fetchedAt: fetchedAt.toISOString(),
    source: "YAHOO_FINANCE",
    sourceUrl: sourceUrl(instrument.symbol),
    isStale: false,
  };
}

export class DeterministicMarketDataProvider implements MarketDataProvider {
  readonly id = "LUBAN_SIMULATED";

  quote(instrument: MarketInstrument, at: Date): Quote {
    const delayedTime = at.getTime() - QUOTE_DELAY_MINUTES * 60_000;
    const minuteBucket = Math.floor(delayedTime / 60_000);
    const seed = hashString(`${instrument.symbol}:${minuteBucket}`);
    const driftBasisPoints = Math.round((pseudoRandom(seed) - 0.5) * 36);
    const priceCents = Math.max(
      1,
      Math.round(
        (instrument.basePriceCents * (10_000 + driftBasisPoints)) / 10_000,
      ),
    );
    const priceCadCents = Math.round(
      (priceCents * instrument.fxRateBasisPoints) / 10_000,
    );
    const previousCloseCadCents = Math.round(
      (instrument.previousCloseCents * instrument.fxRateBasisPoints) / 10_000,
    );
    const changeCents = priceCents - instrument.previousCloseCents;
    const quoteTime = new Date(minuteBucket * 60_000).toISOString();

    return {
      symbol: instrument.symbol,
      name: instrument.name,
      exchange: instrument.exchange,
      sector: instrument.sector,
      listingCurrency: instrument.listingCurrency,
      priceCents,
      priceCadCents,
      previousCloseCents: instrument.previousCloseCents,
      previousCloseCadCents,
      changeCents,
      changePercent: roundPercent(changeCents, instrument.previousCloseCents),
      fxRateBasisPoints: instrument.fxRateBasisPoints,
      asOf: quoteTime,
      source: "LUBAN_SIMULATED",
      sourceUrl: null,
      isStale: false,
      // The synthetic market never closes so tests and demos can trade at
      // any hour; only real providers enforce exchange sessions.
      marketOpen: true,
      marketClosesAt: null,
      marketOpensAt: null,
      assetClass: instrumentAssetClass(instrument),
      lotSize: lotSizeFromExponent(instrument.lotExponent ?? 0),
      tradingHaltReason: null,
    };
  }

  async refreshQuote(instrument: MarketInstrument, at: Date): Promise<Quote> {
    return this.quote(instrument, at);
  }

  async history(
    instrument: MarketInstrument,
    range: QuoteRange,
    at: Date,
  ): Promise<QuoteHistory> {
    const config = QUOTE_RANGE_CONFIG[range];
    const quote = this.quote(instrument, at);
    const points = Array.from({ length: config.testPointCount }, (_, index) => {
      const remaining = config.testPointCount - index - 1;
      const seed = hashString(`${instrument.symbol}:${range}:${index}`);
      const change = Math.round((pseudoRandom(seed) - 0.5) * 120);
      return {
        at: new Date(at.getTime() - remaining * config.testStepMs).toISOString(),
        openCents: null,
        highCents: null,
        lowCents: null,
        closeCents: Math.max(1, quote.priceCents + change),
        volume: null,
      } satisfies QuoteHistoryPoint;
    });
    points[points.length - 1] = {
      ...points.at(-1)!,
      at: quote.asOf,
      closeCents: quote.priceCents,
    };

    return {
      symbol: instrument.symbol,
      range,
      interval: config.interval,
      listingCurrency: instrument.listingCurrency,
      exchangeTimeZone: "America/Toronto",
      points,
      asOf: points.at(-1)!.at,
      fetchedAt: at.toISOString(),
      source: "LUBAN_SIMULATED",
      sourceUrl: null,
      isStale: false,
    };
  }

  async historicalPrice(
    instrument: MarketInstrument,
    requestedDate: string,
    at: Date,
  ): Promise<HistoricalMarketPrice> {
    const requested = parseHistoricalDate(requestedDate, at);
    const session = new Date(requested);
    while (session.getUTCDay() === 0 || session.getUTCDay() === 6) {
      session.setUTCDate(session.getUTCDate() - 1);
    }
    const sessionDate = session.toISOString().slice(0, 10);
    const seed = hashString(`${instrument.symbol}:historical:${sessionDate}`);
    const driftBasisPoints = Math.round((pseudoRandom(seed) - 0.5) * 2_000);
    const closeCents = Math.max(
      1,
      Math.round(
        (instrument.basePriceCents * (10_000 + driftBasisPoints)) / 10_000,
      ),
    );
    const fxRateBasisPoints = instrument.fxRateBasisPoints;

    return {
      symbol: instrument.symbol,
      requestedDate,
      sessionDate,
      sessionAt: `${sessionDate}T20:00:00.000Z`,
      listingCurrency: instrument.listingCurrency,
      closeCents,
      closeCadCents: Math.round((closeCents * fxRateBasisPoints) / 10_000),
      fxRateBasisPoints,
      fxAsOf: `${sessionDate}T20:00:00.000Z`,
      splitMultiplier: 1,
      source: "LUBAN_SIMULATED",
      sourceUrl: null,
    };
  }

  async splitMultipliers(
    instrument: MarketInstrument,
    sessionDates: string[],
    at: Date,
  ): Promise<Map<string, number>> {
    return new Map(
      await Promise.all(
        sessionDates.map(async (sessionDate) => [
          sessionDate,
          (await this.historicalPrice(instrument, sessionDate, at))
            .splitMultiplier,
        ] as const),
      ),
    );
  }
}

/**
 * Stocks and ETFs trade per share. A listed crypto pair keeps the lot it was
 * given at listing; a pair being discovered gets one from its current price.
 */
function resolveLotExponent(
  instrument: MarketInstrument,
  chart: ParsedYahooChart,
  fxRateBasisPoints: number,
): number {
  if (instrumentAssetClass(instrument) !== "CRYPTO") return 0;
  if (typeof instrument.lotExponent === "number") return instrument.lotExponent;
  const closes = numberArray(chart.quote.close);
  const price =
    finiteNumber(chart.meta.regularMarketPrice) ??
    [...closes].reverse().find((value) => value !== null) ??
    null;
  if (price === null) {
    throw new AppError(
      "MARKET_DATA_INVALID",
      `The market quote for ${instrument.symbol} was incomplete.`,
      503,
    );
  }
  return cryptoLotExponent((price * fxRateBasisPoints) / 10_000);
}

export class YahooFinanceMarketDataProvider implements MarketDataProvider {
  readonly id = "YAHOO_FINANCE";
  private readonly state = yahooState();

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    readonly now: () => number = Date.now,
  ) {}

  quote(instrument: MarketInstrument): Quote {
    const cached = this.state.quotes.get(instrument.symbol);
    if (!cached) {
      throw new AppError(
        "MARKET_DATA_UNAVAILABLE",
        `No real market quote is cached for ${instrument.symbol}.`,
        503,
      );
    }
    return cached.value;
  }

  async refreshQuote(instrument: MarketInstrument): Promise<Quote> {
    const cached = this.state.quotes.get(instrument.symbol);
    const nowMs = this.now();
    if (cached && nowMs - cached.fetchedAtMs < QUOTE_TTL_MS && !cached.value.isStale) {
      return cached.value;
    }

    const recentFailure = this.state.quoteFailures.get(instrument.symbol);
    if (
      recentFailure &&
      nowMs - recentFailure.attemptedAtMs < MARKET_REFRESH_INTERVAL_MS
    ) {
      if (cached) return cached.value;
      throw recentFailure.error;
    }

    try {
      return await this.coalesce(`quote:${instrument.symbol}`, async () => {
        const refreshedCache = this.state.quotes.get(instrument.symbol);
        const refreshedNow = this.now();
        if (
          refreshedCache &&
          refreshedNow - refreshedCache.fetchedAtMs < QUOTE_TTL_MS &&
          !refreshedCache.value.isStale
        ) {
          return refreshedCache.value;
        }

        const [chart, fxRateBasisPoints] = await Promise.all([
          this.fetchChart(instrument.symbol, "1d", "5m"),
          instrument.listingCurrency === "USD"
            ? this.fetchCadFxRate()
            : Promise.resolve(10_000),
        ]);
        validateYahooInstrument(instrument, chart);
        const value = quoteFromYahooChart(
          instrument,
          chart,
          fxRateBasisPoints,
          this.now(),
          resolveLotExponent(instrument, chart, fxRateBasisPoints),
        );
        quoteGeneration += 1;
        boundedSet(this.state.quotes, instrument.symbol, {
          value,
          fetchedAtMs: refreshedNow,
        });
        this.state.quoteFailures.delete(instrument.symbol);
        return value;
      });
    } catch (error) {
      const normalized = normalizeProviderError(
        error,
        `The market quote for ${instrument.symbol}`,
      );
      boundedSet(this.state.quoteFailures, instrument.symbol, {
        error: normalized,
        attemptedAtMs: this.now(),
      });
      const staleCache = this.state.quotes.get(instrument.symbol);
      if (staleCache) {
        const stale = { ...staleCache.value, isStale: true };
        quoteGeneration += 1;
        boundedSet(this.state.quotes, instrument.symbol, {
          value: stale,
          fetchedAtMs: staleCache.fetchedAtMs,
        });
        return stale;
      }
      throw normalized;
    }
  }

  async search(query: string): Promise<InstrumentSearchResult[]> {
    const providerQuery = yahooSearchQuery(query);
    const cacheKey = providerQuery.toLowerCase();
    const cached = this.state.searches.get(cacheKey);
    const nowMs = this.now();
    if (cached && nowMs - cached.fetchedAtMs < SEARCH_TTL_MS) {
      return cached.value;
    }

    const recentFailure = this.state.searchFailures.get(cacheKey);
    if (
      recentFailure &&
      nowMs - recentFailure.attemptedAtMs < MARKET_REFRESH_INTERVAL_MS
    ) {
      if (cached) return cached.value;
      throw recentFailure.error;
    }

    try {
      return await this.coalesce(`search:${cacheKey}`, async () => {
        const refreshedCache = this.state.searches.get(cacheKey);
        const refreshedNow = this.now();
        if (
          refreshedCache &&
          refreshedNow - refreshedCache.fetchedAtMs < SEARCH_TTL_MS
        ) {
          return refreshedCache.value;
        }

        const value = await this.fetchSearch(providerQuery);
        boundedSet(this.state.searches, cacheKey, {
          value,
          fetchedAtMs: refreshedNow,
        });
        for (const instrument of value) {
          boundedSet(this.state.discoveredInstruments, instrument.symbol, instrument);
        }
        this.state.searchFailures.delete(cacheKey);
        return value;
      });
    } catch (error) {
      const normalized = normalizeProviderError(error, "The market symbol search");
      boundedSet(this.state.searchFailures, cacheKey, {
        error: normalized,
        attemptedAtMs: this.now(),
      });
      if (cached) return cached.value;
      throw normalized;
    }
  }

  async resolveInstrument(symbol: string): Promise<InstrumentSearchResult | null> {
    const normalized = normalizeMarketSymbol(symbol);
    const cached = this.state.discoveredInstruments.get(normalized);
    if (cached) return cached;
    const results = await this.search(normalized);
    return results.find((result) => result.symbol === normalized) ?? null;
  }

  async history(
    instrument: MarketInstrument,
    range: QuoteRange,
  ): Promise<QuoteHistory> {
    const key = `${instrument.symbol}:${range}`;
    const cached = this.state.histories.get(key);
    const nowMs = this.now();
    const ttl =
      range === "1D" || range === "5D"
        ? INTRADAY_HISTORY_TTL_MS
        : DAILY_HISTORY_TTL_MS;
    if (cached && nowMs - cached.fetchedAtMs < ttl && !cached.value.isStale) {
      return cached.value;
    }

    try {
      return await this.coalesce(`history:${key}`, async () => {
        const refreshedCache = this.state.histories.get(key);
        const refreshedNow = this.now();
        if (
          refreshedCache &&
          refreshedNow - refreshedCache.fetchedAtMs < ttl &&
          !refreshedCache.value.isStale
        ) {
          return refreshedCache.value;
        }

        const config = QUOTE_RANGE_CONFIG[range];
        const chart = await this.fetchChart(
          instrument.symbol,
          config.providerRange,
          config.interval,
        );
        const value = historyFromYahooChart(
          instrument,
          range,
          chart,
          new Date(refreshedNow),
        );
        boundedSet(this.state.histories, key, { value, fetchedAtMs: refreshedNow });
        return value;
      });
    } catch (error) {
      const staleCache = this.state.histories.get(key);
      if (staleCache) {
        const stale = { ...staleCache.value, isStale: true };
        boundedSet(this.state.histories, key, {
          value: stale,
          fetchedAtMs: staleCache.fetchedAtMs,
        });
        return stale;
      }
      throw normalizeProviderError(error, `The market history for ${instrument.symbol}`);
    }
  }

  async historicalPrice(
    instrument: MarketInstrument,
    requestedDate: string,
    at: Date,
  ): Promise<HistoricalMarketPrice> {
    const requested = parseHistoricalDate(requestedDate, at);
    // Corporate actions are part of this value, so a cache entry must never
    // survive into a new Toronto market date after a split becomes effective.
    const valuationDate = calendarDateInTimeZone(at, "America/Toronto");
    const key = `${instrument.symbol}:${requestedDate}:${valuationDate}`;
    const cached = this.state.historicalPrices.get(key);
    const nowMs = this.now();
    if (cached && nowMs - cached.fetchedAtMs < DAILY_HISTORY_TTL_MS) {
      return cached.value;
    }

    try {
      return await this.coalesce(`historical-price:${key}`, async () => {
        const refreshedCache = this.state.historicalPrices.get(key);
        const refreshedNow = this.now();
        if (
          refreshedCache &&
          refreshedNow - refreshedCache.fetchedAtMs < DAILY_HISTORY_TTL_MS
        ) {
          return refreshedCache.value;
        }

        const dayMs = 86_400_000;
        const narrowStart = Math.floor((requested.getTime() - 10 * dayMs) / 1_000);
        const narrowEnd = Math.floor((requested.getTime() + 2 * dayMs) / 1_000);
        const splitEnd = Math.floor((at.getTime() + dayMs) / 1_000);
        const splitInterval = at.getTime() - requested.getTime() <= 366 * dayMs
          ? "1d"
          : "1mo";
        const [priceChart, fxChart, splitChart] = await Promise.all([
          this.fetchChartBetween(
            instrument.symbol,
            narrowStart,
            narrowEnd,
            "1d",
          ),
          instrument.listingCurrency === "USD"
            ? this.fetchChartBetween("CAD=X", narrowStart, narrowEnd, "1d")
            : Promise.resolve(null),
          this.fetchChartBetween(
            instrument.symbol,
            narrowStart,
            splitEnd,
            splitInterval,
          ),
        ]);
        validateYahooInstrument(instrument, priceChart);
        validateYahooInstrument(instrument, splitChart);
        const historicalClose = selectHistoricalClose(priceChart, requestedDate);
        const fxClose = fxChart
          ? selectHistoricalClose(fxChart, historicalClose.sessionDate)
          : null;
        const fxRateBasisPoints = fxClose
          ? fxClose.closeBasisPoints
          : 10_000;
        const splitMultiplier = splitMultiplierAfter(
          splitChart,
          historicalClose.sessionDate,
          at,
        );
        // Yahoo retrospectively expresses historical `close` values on the
        // latest split-adjusted share basis. Reconstruct the actual per-share
        // close an investor paid on that session; the valuation layer then
        // applies the same multiplier to the share quantity exactly once.
        const contemporaneousCloseCents = Math.round(
          (historicalClose.closeBasisPoints * splitMultiplier) / 100,
        );
        const value: HistoricalMarketPrice = {
          symbol: instrument.symbol,
          requestedDate,
          sessionDate: historicalClose.sessionDate,
          sessionAt: historicalClose.sessionAt,
          listingCurrency: instrument.listingCurrency,
          closeCents: contemporaneousCloseCents,
          closeCadCents: Math.round(
            (contemporaneousCloseCents * fxRateBasisPoints) / 10_000,
          ),
          fxRateBasisPoints,
          fxAsOf: fxClose?.sessionAt ?? historicalClose.sessionAt,
          splitMultiplier,
          source: "YAHOO_FINANCE",
          sourceUrl: sourceUrl(instrument.symbol),
        };
        boundedSet(this.state.historicalPrices, key, {
          value,
          fetchedAtMs: refreshedNow,
        });
        return value;
      });
    } catch (error) {
      throw normalizeProviderError(
        error,
        `The historical market price for ${instrument.symbol}`,
      );
    }
  }

  async splitMultipliers(
    instrument: MarketInstrument,
    sessionDates: string[],
    at: Date,
  ): Promise<Map<string, number>> {
    const dates = [...new Set(sessionDates)].sort();
    if (dates.length === 0) return new Map();
    for (const sessionDate of dates) {
      parseHistoricalDate(sessionDate, at);
    }

    const valuationDate = calendarDateInTimeZone(at, "America/Toronto");
    const key = `${instrument.symbol}:${dates.join(",")}:${valuationDate}`;
    const cached = this.state.splitMultipliers.get(key);
    const nowMs = this.now();
    if (cached && nowMs - cached.fetchedAtMs < DAILY_HISTORY_TTL_MS) {
      return new Map(cached.value);
    }

    try {
      return await this.coalesce(`split-multipliers:${key}`, async () => {
        const refreshedCache = this.state.splitMultipliers.get(key);
        const refreshedNow = this.now();
        if (
          refreshedCache &&
          refreshedNow - refreshedCache.fetchedAtMs < DAILY_HISTORY_TTL_MS
        ) {
          return new Map(refreshedCache.value);
        }

        const dayMs = 86_400_000;
        const earliest = Date.parse(`${dates[0]}T00:00:00.000Z`);
        const start = Math.floor((earliest - dayMs) / 1_000);
        const end = Math.floor((at.getTime() + dayMs) / 1_000);
        const interval = at.getTime() - earliest <= 366 * dayMs ? "1d" : "1mo";
        const chart = await this.fetchChartBetween(
          instrument.symbol,
          start,
          end,
          interval,
        );
        validateYahooInstrument(instrument, chart);
        const value = new Map(
          dates.map((sessionDate) => [
            sessionDate,
            splitMultiplierAfter(chart, sessionDate, at),
          ]),
        );
        boundedSet(this.state.splitMultipliers, key, {
          value,
          fetchedAtMs: refreshedNow,
        });
        return new Map(value);
      });
    } catch (error) {
      throw normalizeProviderError(
        error,
        `The corporate-action history for ${instrument.symbol}`,
      );
    }
  }

  private async fetchCadFxRate(): Promise<number> {
    return this.coalesce("fx:CAD", async () => {
      const chart = await this.fetchChart("CAD=X", "1d", "5m");
      const rate = finiteNumber(chart.meta.regularMarketPrice);
      if (rate === null || rate <= 0) {
        throw new AppError(
          "MARKET_DATA_INVALID",
          "The USD/CAD market rate was unavailable.",
          503,
        );
      }
      return Math.round(rate * 10_000);
    });
  }

  private async fetchSearch(query: string): Promise<InstrumentSearchResult[]> {
    const params = new URLSearchParams({
      q: query,
      quotesCount: "25",
      newsCount: "0",
      listsCount: "0",
      enableFuzzyQuery: "true",
    });
    let response: Response;
    try {
      response = await this.fetcher(`${YAHOO_SEARCH_URL}?${params.toString()}`, {
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 LubanMarketLab/0.1",
        },
        signal: AbortSignal.timeout(MARKET_DATA_TIMEOUT_MS),
      });
    } catch (error) {
      throw normalizeProviderError(error, "The market symbol search");
    }

    if (response.status === 429) {
      throw new AppError(
        "MARKET_DATA_RATE_LIMITED",
        "The free market data service is busy. Try again shortly.",
        503,
        { retryAfterSeconds: 60 },
      );
    }
    if (!response.ok) {
      throw new AppError(
        "MARKET_DATA_UNAVAILABLE",
        `The market symbol search returned HTTP ${response.status}.`,
        503,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AppError(
        "MARKET_DATA_INVALID",
        "The market symbol search did not return valid JSON.",
        503,
      );
    }
    return parseYahooSearch(payload);
  }

  private async fetchChart(
    symbol: string,
    range: string,
    interval: string,
  ): Promise<ParsedYahooChart> {
    return this.fetchChartWithParams(symbol, {
      range,
      interval,
    });
  }

  private async fetchChartBetween(
    symbol: string,
    period1: number,
    period2: number,
    interval: string,
  ): Promise<ParsedYahooChart> {
    return this.fetchChartWithParams(symbol, {
      period1: String(period1),
      period2: String(period2),
      interval,
    });
  }

  private async fetchChartWithParams(
    symbol: string,
    input: Record<string, string>,
  ): Promise<ParsedYahooChart> {
    const params = new URLSearchParams({
      ...input,
      includePrePost: "false",
      events: "div,splits",
    });
    let response: Response;
    try {
      response = await this.fetcher(
        `${YAHOO_CHART_URL}/${encodeURIComponent(symbol)}?${params.toString()}`,
        {
          cache: "no-store",
          headers: {
            Accept: "application/json",
            "User-Agent": "Mozilla/5.0 LubanMarketLab/0.1",
          },
          signal: AbortSignal.timeout(MARKET_DATA_TIMEOUT_MS),
        },
      );
    } catch (error) {
      throw normalizeProviderError(error, `The market data request for ${symbol}`);
    }

    if (response.status === 429) {
      throw new AppError(
        "MARKET_DATA_RATE_LIMITED",
        "The free market data service is busy. Try again shortly.",
        503,
        { retryAfterSeconds: 60 },
      );
    }
    if (!response.ok) {
      throw new AppError(
        "MARKET_DATA_UNAVAILABLE",
        `The market data service returned HTTP ${response.status} for ${symbol}.`,
        503,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AppError(
        "MARKET_DATA_INVALID",
        `The market data response for ${symbol} was not valid JSON.`,
        503,
      );
    }
    return parseYahooChart(payload, symbol);
  }

  private async coalesce<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.state.inFlight.get(key);
    if (existing) return existing as Promise<T>;
    const pending = work().finally(() => this.state.inFlight.delete(key));
    this.state.inFlight.set(key, pending);
    return pending;
  }
}

function createDefaultProvider(): MarketDataProvider {
  const configured = process.env.LUBAN_MARKET_DATA_PROVIDER?.trim().toLowerCase();
  return configured === "synthetic" || process.env.NODE_ENV === "test"
    ? new DeterministicMarketDataProvider()
    : new YahooFinanceMarketDataProvider();
}

let activeProvider: MarketDataProvider = createDefaultProvider();

export function setMarketDataProvider(provider: MarketDataProvider): void {
  activeProvider = provider;
}

export function getMarketDataProvider(): MarketDataProvider {
  return activeProvider;
}

/** Current time on the active provider's clock (wall clock by default). */
export function marketDataNow(): Date {
  return new Date(activeProvider.now ? activeProvider.now() : Date.now());
}

function normalizeAt(at?: Date | string): Date {
  if (!at) return new Date();
  const parsed = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError("INVALID_QUOTE_TIME", "The quote timestamp is invalid.", 400);
  }
  return parsed;
}

async function readInstruments(): Promise<MarketInstrument[]> {
  const db = await getDb();
  const rows = await db.all<InstrumentRow>(`
      SELECT ${INSTRUMENT_COLUMNS}
      FROM instruments
      WHERE is_active = 1
      ORDER BY symbol ASC
    `);
  return rows.map(rowToInstrument);
}

async function readRefreshInstruments(): Promise<MarketInstrument[]> {
  const db = await getDb();
  const rows = await db.all<InstrumentRow>(`
      SELECT
        i.symbol, i.name, i.exchange, i.sector, i.listing_currency,
        i.base_price_cents, i.previous_close_cents, i.fx_rate_basis_points,
        i.asset_class, i.lot_exponent, i.last_price_cents, i.last_priced_at
      FROM instruments AS i
      WHERE i.is_active = 1
        AND (
          i.auto_refresh = 1
          OR EXISTS (
            SELECT 1
            FROM holdings AS h
            WHERE h.symbol = i.symbol AND h.quantity > 0
          )
        )
      ORDER BY i.symbol ASC
    `);
  return rows.map(rowToInstrument);
}

async function readInstrumentSearchResults(
  query: string,
): Promise<InstrumentSearchResult[]> {
  const normalized = `%${query.trim().toLowerCase()}%`;
  const db = await getDb();
  const rows = await db.all<InstrumentRow>(
    `
      SELECT ${INSTRUMENT_COLUMNS}
      FROM instruments
      WHERE is_active = 1
        AND (
          lower(symbol) LIKE ?
          OR lower(name) LIKE ?
          OR lower(exchange) LIKE ?
          OR lower(sector) LIKE ?
        )
      ORDER BY symbol ASC
      LIMIT 25
    `,
    [normalized, normalized, normalized, normalized],
  );
  return rows.map((row) => ({
    symbol: row.symbol,
    name: row.name,
    exchange: row.exchange,
    sector: row.sector,
    listingCurrency: row.listing_currency,
    assetClass: row.asset_class ?? "STOCK",
  }));
}

async function readInstrument(
  symbol: string,
  options: { includeInactive?: boolean } = {},
): Promise<MarketInstrument | null> {
  const db = await getDb();
  const row = await db.get<InstrumentRow>(
    `
      SELECT ${INSTRUMENT_COLUMNS}
      FROM instruments
      WHERE symbol = ? ${options.includeInactive ? "" : "AND is_active = 1"}
    `,
    [normalizeMarketSymbol(symbol)],
  );
  return row ? rowToInstrument(row) : null;
}

function instrumentFromSearchResult(
  result: InstrumentSearchResult,
): MarketInstrument {
  const assetClass = result.assetClass ?? "STOCK";
  return {
    ...result,
    assetClass,
    basePriceCents: 1,
    previousCloseCents: 1,
    fxRateBasisPoints: result.listingCurrency === "CAD" ? 10_000 : 13_600,
    // A crypto pair's lot is fixed from its first real price.
    lotExponent: assetClass === "CRYPTO" ? null : 0,
  };
}

async function persistDiscoveredInstrument(
  result: InstrumentSearchResult,
  quote: Quote,
): Promise<void> {
  const db = await getDb();
  // asset_class and lot_exponent are deliberately left alone on conflict:
  // holdings are counted in lots, so a listed pair's lot can never change.
  await db.run(
    `
      INSERT INTO instruments (
        symbol, name, exchange, sector, listing_currency,
        base_price_cents, previous_close_cents, fx_rate_basis_points,
        is_active, auto_refresh,
        asset_class, lot_exponent, last_price_cents, last_priced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)
      ON CONFLICT(symbol) DO UPDATE SET
        name = excluded.name,
        exchange = excluded.exchange,
        sector = excluded.sector,
        listing_currency = excluded.listing_currency,
        base_price_cents = excluded.base_price_cents,
        previous_close_cents = excluded.previous_close_cents,
        fx_rate_basis_points = excluded.fx_rate_basis_points,
        last_price_cents = excluded.last_price_cents,
        last_priced_at = excluded.last_priced_at,
        is_active = 1
    `,
    [
      result.symbol,
      result.name,
      result.exchange,
      result.sector,
      result.listingCurrency,
      quote.priceCents,
      quote.previousCloseCents,
      quote.fxRateBasisPoints,
      quote.assetClass ?? "STOCK",
      lotExponentFromSize(quote.lotSize ?? 1),
      quote.priceCents,
      new Date().toISOString(),
    ],
  );
}

const lastPricePersistedAt = new Map<string, number>();

/**
 * Remember the last good crypto price in the database, at most every ten
 * minutes per pair. It values holdings when no live quote can be produced,
 * for example after a cold start while a coin is no longer quoted.
 */
async function rememberLastPrice(quote: Quote | null): Promise<void> {
  if (!quote || quote.assetClass !== "CRYPTO" || quote.isStale) return;
  const nowMs = Date.now();
  const previous = lastPricePersistedAt.get(quote.symbol);
  if (previous !== undefined && nowMs - previous < LAST_PRICE_PERSIST_INTERVAL_MS) {
    return;
  }
  boundedSet(lastPricePersistedAt, quote.symbol, nowMs);
  const db = await getDb();
  await db.run(
    `UPDATE instruments
     SET last_price_cents = ?, last_priced_at = ?
     WHERE symbol = ?`,
    [quote.priceCents, quote.asOf, quote.symbol],
  );
}

/**
 * A stand-in quote for a crypto holding whose live price is unavailable. It
 * keeps the portfolio and leaderboard working at the last known price while
 * trading in that pair stays paused.
 */
function lastKnownCryptoQuote(instrument: MarketInstrument): Quote {
  const priceCents = instrument.lastPriceCents ?? instrument.basePriceCents;
  const priceCadCents = Math.round(
    (priceCents * instrument.fxRateBasisPoints) / 10_000,
  );
  return {
    symbol: instrument.symbol,
    name: instrument.name,
    exchange: instrument.exchange,
    sector: instrument.sector,
    listingCurrency: instrument.listingCurrency,
    priceCents,
    priceCadCents,
    previousCloseCents: priceCents,
    previousCloseCadCents: priceCadCents,
    changeCents: 0,
    changePercent: 0,
    fxRateBasisPoints: instrument.fxRateBasisPoints,
    asOf: instrument.lastPricedAt ?? new Date(0).toISOString(),
    source: activeProvider.id === "YAHOO_FINANCE" ? "YAHOO_FINANCE" : "LUBAN_SIMULATED",
    sourceUrl: sourceUrl(instrument.symbol),
    isStale: true,
    ...ALWAYS_OPEN_SESSION,
    assetClass: "CRYPTO",
    lotSize: lotSizeFromExponent(instrument.lotExponent ?? 0),
    tradingHaltReason: `Trading in ${instrument.symbol} is paused because no current price is available. It is valued at its last known price.`,
  };
}

async function resolveInstrument(
  symbol: string,
): Promise<InstrumentSearchResult | null> {
  if (activeProvider.resolveInstrument) {
    return activeProvider.resolveInstrument(symbol);
  }
  if (!activeProvider.search) return null;
  const results = await activeProvider.search(symbol);
  return results.find((result) => result.symbol === symbol) ?? null;
}

export async function refreshQuote(
  symbol: string,
  at?: Date | string,
): Promise<Quote | null> {
  const normalizedSymbol = normalizeMarketSymbol(symbol);
  let instrument = await readInstrument(normalizedSymbol);
  const quoteAt = normalizeAt(at);
  if (!instrument) {
    if (
      !MARKET_SYMBOL_PATTERN.test(normalizedSymbol) ||
      isSymbolBlocked(normalizedSymbol)
    ) {
      return null;
    }
    const discovered = await resolveInstrument(normalizedSymbol);
    if (!discovered || discovered.symbol !== normalizedSymbol) return null;
    if (!isAssetClassEnabled(discovered.assetClass)) return null;
    // A previously listed but deactivated row keeps its asset class and lot.
    const previous = await readInstrument(normalizedSymbol, { includeInactive: true });
    instrument = previous
      ? { ...instrumentFromSearchResult(discovered), ...previous }
      : instrumentFromSearchResult(discovered);
    const quote = activeProvider.refreshQuote
      ? await activeProvider.refreshQuote(instrument, quoteAt)
      : activeProvider.quote(instrument, quoteAt);
    if (quote.assetClass === "CRYPTO" && quote.tradingHaltReason) {
      throw new AppError(
        "ASSET_NOT_TRADABLE",
        `${normalizedSymbol} can't be added to the simulator: ${quote.tradingHaltReason.replace(/^Trading in \S+ is paused because /, "")}`,
        422,
        { symbol: normalizedSymbol },
      );
    }
    await persistDiscoveredInstrument(discovered, quote);
    return quote;
  }
  const quote = activeProvider.refreshQuote
    ? await activeProvider.refreshQuote(instrument, quoteAt)
    : activeProvider.quote(instrument, quoteAt);
  await rememberLastPrice(quote);
  return quote;
}

export async function refreshAllQuotes(at?: Date | string): Promise<void> {
  const quoteAt = normalizeAt(at);
  const results = await Promise.allSettled(
    (await readRefreshInstruments()).map((instrument) =>
      activeProvider.refreshQuote
        ? activeProvider.refreshQuote(instrument, quoteAt)
        : Promise.resolve(activeProvider.quote(instrument, quoteAt)),
    ),
  );
  await Promise.allSettled(
    results.map((result) =>
      result.status === "fulfilled" ? rememberLastPrice(result.value) : null,
    ),
  );
  if (results.every((result) => result.status === "rejected")) {
    const first = results[0];
    throw first.status === "rejected"
      ? first.reason
      : new AppError(
          "MARKET_DATA_UNAVAILABLE",
          "No market quotes are currently available.",
          503,
        );
  }
}

export async function getQuote(
  symbol: string,
  at?: Date | string,
): Promise<Quote | null> {
  const instrument = await readInstrument(symbol);
  if (!instrument) return null;
  try {
    return activeProvider.quote(instrument, normalizeAt(at));
  } catch (error) {
    if (
      error instanceof AppError &&
      ["MARKET_DATA_UNAVAILABLE", "MARKET_DATA_TIMEOUT"].includes(error.code)
    ) {
      // Coins can stop being quoted; their holdings must stay valued so one
      // dead pair never breaks a portfolio or the leaderboard.
      return instrumentAssetClass(instrument) === "CRYPTO"
        ? lastKnownCryptoQuote(instrument)
        : null;
    }
    throw error;
  }
}

export async function requireQuote(
  symbol: string,
  at?: Date | string,
): Promise<Quote> {
  const quote = await getQuote(symbol, at);
  if (!quote) {
    throw new AppError(
      "UNKNOWN_SYMBOL",
      `The symbol ${symbol.trim().toUpperCase()} is not available in this simulation.`,
      404,
      { symbol: symbol.trim().toUpperCase() },
    );
  }
  return quote;
}

export async function getQuoteHistory(
  symbol: string,
  range: QuoteRange,
  at?: Date | string,
): Promise<QuoteHistory> {
  const instrument = await readInstrument(symbol);
  if (!instrument) {
    throw new AppError(
      "UNKNOWN_SYMBOL",
      `The symbol ${symbol.trim().toUpperCase()} is not available in this simulation.`,
      404,
      { symbol: symbol.trim().toUpperCase() },
    );
  }
  if (!QUOTE_RANGES.includes(range)) {
    throw new AppError("INVALID_QUOTE_RANGE", "Unsupported quote range.", 400);
  }
  if (!activeProvider.history) {
    throw new AppError(
      "MARKET_HISTORY_UNAVAILABLE",
      `Market history is not available for ${instrument.symbol}.`,
      503,
    );
  }
  return activeProvider.history(instrument, range, normalizeAt(at));
}

export async function getHistoricalMarketPrice(
  symbol: string,
  requestedDate: string,
  at?: Date | string,
): Promise<HistoricalMarketPrice> {
  const quoteAt = normalizeAt(at);
  parseHistoricalDate(requestedDate, quoteAt);
  const normalizedSymbol = normalizeMarketSymbol(symbol);
  let instrument = await readInstrument(normalizedSymbol);

  if (!instrument) {
    await refreshQuote(normalizedSymbol, quoteAt);
    instrument = await readInstrument(normalizedSymbol);
  }
  if (!instrument) {
    throw new AppError(
      "UNKNOWN_SYMBOL",
      `The symbol ${normalizedSymbol} is not available in this simulation.`,
      404,
      { symbol: normalizedSymbol },
    );
  }
  if (instrumentAssetClass(instrument) === "CRYPTO") {
    throw new AppError(
      "HISTORICAL_PRICE_UNAVAILABLE",
      `Historical purchase pricing is not available for crypto (${instrument.symbol}).`,
      400,
    );
  }
  if (!activeProvider.historicalPrice) {
    throw new AppError(
      "HISTORICAL_PRICE_UNAVAILABLE",
      `Historical purchase pricing is not available for ${instrument.symbol}.`,
      503,
    );
  }
  return activeProvider.historicalPrice(instrument, requestedDate, quoteAt);
}

export async function getHistoricalSplitMultipliers(
  symbol: string,
  sessionDates: string[],
  at?: Date | string,
): Promise<Map<string, number>> {
  const quoteAt = normalizeAt(at);
  const dates = [...new Set(sessionDates)].sort();
  if (dates.length === 0) return new Map();
  for (const sessionDate of dates) {
    parseHistoricalDate(sessionDate, quoteAt);
  }

  const normalizedSymbol = normalizeMarketSymbol(symbol);
  let instrument = await readInstrument(normalizedSymbol);
  if (!instrument) {
    await refreshQuote(normalizedSymbol, quoteAt);
    instrument = await readInstrument(normalizedSymbol);
  }
  if (!instrument) {
    throw new AppError(
      "UNKNOWN_SYMBOL",
      `The symbol ${normalizedSymbol} is not available in this simulation.`,
      404,
      { symbol: normalizedSymbol },
    );
  }

  if (instrumentAssetClass(instrument) === "CRYPTO") {
    throw new AppError(
      "HISTORICAL_PRICE_UNAVAILABLE",
      `Historical purchase pricing is not available for crypto (${instrument.symbol}).`,
      400,
    );
  }
  if (activeProvider.splitMultipliers) {
    return activeProvider.splitMultipliers(instrument, dates, quoteAt);
  }
  if (!activeProvider.historicalPrice) {
    throw new AppError(
      "HISTORICAL_PRICE_UNAVAILABLE",
      `Corporate-action history is not available for ${instrument.symbol}.`,
      503,
    );
  }

  return new Map(
    await Promise.all(
      dates.map(async (sessionDate) => [
        sessionDate,
        (
          await activeProvider.historicalPrice!(
            instrument,
            sessionDate,
            quoteAt,
          )
        ).splitMultiplier,
      ] as const),
    ),
  );
}

export async function listQuotes(at?: Date | string): Promise<Quote[]> {
  const quoteAt = normalizeAt(at);
  return (await readInstruments()).flatMap((instrument) => {
    try {
      return [activeProvider.quote(instrument, quoteAt)];
    } catch (error) {
      if (error instanceof AppError && error.code.startsWith("MARKET_DATA_")) {
        return [];
      }
      throw error;
    }
  });
}

export async function searchInstruments(
  query: string,
  at?: Date | string,
): Promise<Quote[]> {
  const normalized = query.trim().toLowerCase();
  const quotes = await listQuotes(at);
  if (!normalized) return quotes;
  return quotes.filter((quote) =>
    [quote.symbol, quote.name, quote.exchange, quote.sector].some((value) =>
      value.toLowerCase().includes(normalized),
    ),
  );
}

export async function searchMarketInstruments(
  query: string,
): Promise<InstrumentSearchResult[]> {
  const normalizedQuery = query.trim();
  // Listed ETFs and crypto stay hidden while their switch is off.
  const local = (await readInstrumentSearchResults(normalizedQuery)).filter(
    (result) =>
      isAssetClassEnabled(result.assetClass) && !isSymbolBlocked(result.symbol),
  );
  const exactSymbol = normalizeMarketSymbol(normalizedQuery);
  const tsxAlias = tsxAliasForBareTickerQuery(normalizedQuery);
  // A bare ticker like BTC can be both a listed fund and a coin (BTC-CAD), so
  // with crypto on, a local exact match must not hide the remote search.
  const coinPairs =
    isCryptoTradingEnabled() && /^[A-Z0-9]+$/.test(exactSymbol)
      ? [`${exactSymbol}-CAD`, `${exactSymbol}-USD`]
      : [];
  const exactLocal = local.find((result) => result.symbol === exactSymbol);
  if (exactLocal && coinPairs.length === 0) return [exactLocal];

  const exactTsxLocal = tsxAlias
    ? local.find((result) => result.symbol === tsxAlias)
    : undefined;
  if (exactTsxLocal && coinPairs.length === 0) {
    return [
      exactTsxLocal,
      ...local.filter((result) => result.symbol !== exactTsxLocal.symbol),
    ].slice(0, 25);
  }

  let remote: InstrumentSearchResult[] = [];
  let primarySearchError: unknown;
  if (activeProvider.search) {
    try {
      remote = await activeProvider.search(normalizedQuery);
    } catch (error) {
      primarySearchError = error;
    }

    const hasLiteralExact = remote.some(
      (result) => result.symbol === exactSymbol,
    );
    const hasTsxExact = tsxAlias
      ? remote.some((result) => result.symbol === tsxAlias)
      : false;

    // Yahoo's fuzzy search for a bare Canadian ticker can omit its TSX
    // listing entirely (for example, PET returns petroleum companies while
    // PET.TO returns Pet Valu). Probe the exact TSX alias only when the first
    // result set has no literal exact match. Each query is cached for ten
    // minutes by the provider, so repeated searches do not multiply calls.
    if (tsxAlias && !hasLiteralExact && !hasTsxExact) {
      try {
        remote = [...remote, ...(await activeProvider.search(tsxAlias))];
      } catch (error) {
        if (!primarySearchError) primarySearchError = error;
      }
    }
  }

  const merged = new Map<string, InstrumentSearchResult>();
  for (const result of [...remote, ...local]) {
    if (!merged.has(result.symbol)) merged.set(result.symbol, result);
  }
  // Exact ticker first, then that coin's pairs (CAD before USD), then the
  // TSX alias; everything else keeps the provider's relevance order.
  const priority = [exactSymbol, ...coinPairs, ...(tsxAlias ? [tsxAlias] : [])];
  const rank = (symbol: string) => {
    const index = priority.indexOf(symbol);
    return index === -1 ? priority.length : index;
  };
  const results = [...merged.values()]
    .map((result, order) => ({ result, order }))
    .sort((left, right) =>
      rank(left.result.symbol) - rank(right.result.symbol) || left.order - right.order,
    )
    .map(({ result }) => result)
    .slice(0, 25);

  if (results.length === 0 && primarySearchError) {
    throw primarySearchError;
  }

  return results;
}
