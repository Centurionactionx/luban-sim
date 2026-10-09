import type { AssetClass, TimeInForce } from "./contracts";
import { isoToZonedInputValue, zonedInputValueToIso } from "./time";

/**
 * The trading calendar in Eastern time: which days the markets trade, when a
 * day order ends, and when stock markets could be open. Pure and safe to
 * import from client components, so the order ticket and the server agree.
 */

function torontoDateParts(at: Date): { date: string; minutes: number; weekday: number } {
  const value = isoToZonedInputValue(at.toISOString());
  const [date, time] = value.split("T");
  const [hour, minute] = time.split(":").map(Number);
  const [year, month, day] = date.split("-").map(Number);
  return {
    date,
    minutes: hour * 60 + minute,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

function nextCalendarDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

/**
 * Full-day closures. CAD listings follow the TSX calendar, USD listings the
 * NYSE/Nasdaq one. Early (1 p.m.) closes are not modelled. Extend the lists
 * each year; a missing year falls back to weekdays only.
 */
const MARKET_HOLIDAYS: Record<"CAD" | "USD", ReadonlySet<string>> = {
  CAD: new Set([
    "2026-01-01", "2026-02-16", "2026-04-03", "2026-05-18", "2026-07-01",
    "2026-08-03", "2026-09-07", "2026-10-12", "2026-12-25", "2026-12-28",
    "2027-01-01", "2027-02-15", "2027-03-26", "2027-05-24", "2027-07-01",
    "2027-08-02", "2027-09-06", "2027-10-11", "2027-12-27", "2027-12-28",
  ]),
  USD: new Set([
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
    "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
    "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
    "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
  ]),
};

function isTradingDay(
  date: string,
  weekday: number,
  listingCurrency: "CAD" | "USD" | undefined,
): boolean {
  if (weekday === 0 || weekday === 6) return false;
  return !listingCurrency || !MARKET_HOLIDAYS[listingCurrency].has(date);
}

/**
 * When a DAY order stops working. Stocks and ETFs: the next 4:00 p.m.
 * Eastern close on a trading day of the listing's market (today's, if placed
 * before it), so an order placed before a holiday still gets a session.
 * Crypto trades around the clock, so its "day" is the Eastern calendar day.
 * GTC orders have no clock expiry; they end with the competition.
 */
export function workingOrderExpiresAt(
  timeInForce: TimeInForce,
  assetClass: AssetClass | undefined,
  at: Date,
  listingCurrency?: "CAD" | "USD",
): string | null {
  if (timeInForce === "GTC") return null;
  const now = torontoDateParts(at);

  if (assetClass === "CRYPTO") {
    return zonedInputValueToIso(`${nextCalendarDate(now.date)}T00:00`);
  }

  let date = now.date;
  let weekday = now.weekday;
  const closeMinutes = 16 * 60;
  if (!isTradingDay(date, weekday, listingCurrency) || now.minutes >= closeMinutes) {
    do {
      date = nextCalendarDate(date);
      weekday = (weekday + 1) % 7;
    } while (!isTradingDay(date, weekday, listingCurrency));
  }
  return zonedInputValueToIso(`${date}T16:00`);
}

/**
 * Whether North American stock and ETF markets could be open: trading days,
 * 9:25 a.m. to 4:05 p.m. Eastern (a few minutes either side of the session).
 * Lets the price checker skip fetching stock quotes at night, on weekends and
 * on holidays;
 * the quote's own session data still decides whether a fill happens.
 */
export function stockSessionMayBeOpen(at: Date): boolean {
  const now = torontoDateParts(at);
  // Skipped only when both the TSX and the US markets are closed that day.
  if (
    !isTradingDay(now.date, now.weekday, "CAD") &&
    !isTradingDay(now.date, now.weekday, "USD")
  ) {
    return false;
  }
  return now.minutes >= 9 * 60 + 25 && now.minutes <= 16 * 60 + 5;
}
