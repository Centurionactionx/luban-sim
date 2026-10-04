/**
 * Which bar sizes a chart may ask for, and over which dates. Shared by the
 * history route (to reject what the free feed cannot serve) and the chart
 * (to only offer choices that will load).
 */

import type { QuoteRange } from "./contracts";

export const QUOTE_INTERVALS = ["1m", "2m", "5m", "15m", "30m", "60m", "1d", "1wk"] as const;
export type QuoteInterval = (typeof QUOTE_INTERVALS)[number];

export const QUOTE_INTERVAL_LABELS: Record<QuoteInterval, string> = {
  "1m": "1 min",
  "2m": "2 min",
  "5m": "5 min",
  "15m": "15 min",
  "30m": "30 min",
  "60m": "1 hour",
  "1d": "1 day",
  "1wk": "1 week",
};

export const DEFAULT_QUOTE_INTERVAL: Record<QuoteRange, QuoteInterval> = {
  "1D": "5m",
  "5D": "15m",
  "1M": "1d",
  "3M": "1d",
};

/** Trading minutes one bar covers, using a 6.5-hour equity session. */
const SESSION_MINUTES = 390;
const INTERVAL_TRADING_MINUTES: Record<QuoteInterval, number> = {
  "1m": 1,
  "2m": 2,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "60m": 60,
  "1d": SESSION_MINUTES,
  "1wk": SESSION_MINUTES * 5,
};

/** How far back the free feed keeps each intraday bar size, in days. */
const MAX_AGE_DAYS: Partial<Record<QuoteInterval, number>> = {
  "1m": 30,
  "2m": 60,
  "5m": 60,
  "15m": 60,
  "30m": 60,
  "60m": 730,
};

/** The longest window one request may cover at this bar size, in days. */
const MAX_SPAN_DAYS: Partial<Record<QuoteInterval, number>> = { "1m": 7 };

/** Enough bars to draw a line; few enough to stay quick to hover. */
const MIN_BARS = 2;
export const MAX_HISTORY_BARS = 1_000;
/** A new window starts on the finest bars that stay under this count. */
const COMFORTABLE_BARS = 400;

/** The earliest custom start date the picker accepts. */
export const EARLIEST_HISTORY_DATE = "2000-01-01";
const MAX_CUSTOM_SPAN_DAYS = 3_660;

const DAY_MS = 86_400_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface HistoryWindow {
  /** Calendar days covered. */
  spanDays: number;
  /** Approximate trading sessions covered. */
  tradingDays: number;
  /** Calendar days from the window's first date back from today. */
  ageDays: number;
}

const PRESET_WINDOWS: Record<QuoteRange, HistoryWindow> = {
  // Ages allow for a long weekend before the most recent session.
  "1D": { spanDays: 1, tradingDays: 1, ageDays: 4 },
  "5D": { spanDays: 7, tradingDays: 5, ageDays: 9 },
  "1M": { spanDays: 31, tradingDays: 22, ageDays: 31 },
  "3M": { spanDays: 92, tradingDays: 64, ageDays: 92 },
};

export function presetHistoryWindow(range: QuoteRange): HistoryWindow {
  return PRESET_WINDOWS[range];
}

/** Today's date in Toronto, as YYYY-MM-DD. */
export function torontoToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function dateToUtcMs(date: string): number | null {
  if (!DATE_PATTERN.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  // Rejects dates such as 2026-02-31 that Date would roll forward.
  return new Date(ms).toISOString().slice(0, 10) === date ? ms : null;
}

export type CustomWindowResult =
  | { ok: true; window: HistoryWindow; fromMs: number; toMs: number }
  | { ok: false; message: string };

/** Validates a custom from/to pair (YYYY-MM-DD, inclusive). */
export function customHistoryWindow(
  from: string,
  to: string,
  now: Date = new Date(),
): CustomWindowResult {
  const fromMs = dateToUtcMs(from);
  const toMs = dateToUtcMs(to);
  const todayMs = dateToUtcMs(torontoToday(now))!;
  if (fromMs === null || toMs === null) {
    return { ok: false, message: "Enter both dates as YYYY-MM-DD." };
  }
  if (fromMs > toMs) {
    return { ok: false, message: "The start date must be on or before the end date." };
  }
  if (toMs > todayMs) {
    return { ok: false, message: "The end date can't be in the future." };
  }
  if (fromMs < dateToUtcMs(EARLIEST_HISTORY_DATE)!) {
    return { ok: false, message: `The start date can't be before ${EARLIEST_HISTORY_DATE}.` };
  }
  const spanDays = Math.round((toMs - fromMs) / DAY_MS) + 1;
  if (spanDays > MAX_CUSTOM_SPAN_DAYS) {
    return { ok: false, message: "Pick a window of ten years or less." };
  }
  return {
    ok: true,
    fromMs,
    toMs,
    window: {
      spanDays,
      tradingDays: Math.max(1, Math.round((spanDays * 5) / 7)),
      ageDays: Math.round((todayMs - fromMs) / DAY_MS),
    },
  };
}

export function estimatedBars(interval: QuoteInterval, window: HistoryWindow): number {
  return (window.tradingDays * SESSION_MINUTES) / INTERVAL_TRADING_MINUTES[interval];
}

export function isIntradayInterval(interval: QuoteInterval): boolean {
  return INTERVAL_TRADING_MINUTES[interval] < SESSION_MINUTES;
}

/** Bar sizes the feed serves for this window, finest first. */
export function allowedIntervals(window: HistoryWindow): QuoteInterval[] {
  return QUOTE_INTERVALS.filter((interval) => {
    const maxAge = MAX_AGE_DAYS[interval];
    const maxSpan = MAX_SPAN_DAYS[interval];
    const bars = estimatedBars(interval, window);
    return (
      (maxAge === undefined || window.ageDays <= maxAge) &&
      (maxSpan === undefined || window.spanDays <= maxSpan) &&
      bars >= MIN_BARS &&
      bars <= MAX_HISTORY_BARS
    );
  });
}

/**
 * The requested bar size when the window allows it; otherwise the finest
 * size that keeps the chart comfortable, falling back to the coarsest.
 */
export function resolveInterval(
  window: HistoryWindow,
  requested: QuoteInterval | null,
): QuoteInterval | null {
  const allowed = allowedIntervals(window);
  if (allowed.length === 0) return null;
  if (requested && allowed.includes(requested)) return requested;
  return (
    allowed.find((interval) => estimatedBars(interval, window) <= COMFORTABLE_BARS) ??
    allowed.at(-1)!
  );
}

export function isQuoteInterval(value: string): value is QuoteInterval {
  return (QUOTE_INTERVALS as readonly string[]).includes(value);
}
