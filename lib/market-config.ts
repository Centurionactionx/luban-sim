import type { Quote } from "@/lib/contracts";

export const TEAM_SYNC_INTERVAL_MS = 120_000;
export const MARKET_REFRESH_INTERVAL_MS = 60_000;
/** How often the dashboard polls while no market is in session. */
export const IDLE_SYNC_INTERVAL_MS = 5 * 60_000;

/**
 * True when every quote on the page is fresh and its market is shut, so no
 * price can move. Crypto quotes always report open, and a stale or missing
 * quote means the session is unknown, so both keep the fast pace.
 */
export function allMarketsClosed(quotes: Quote[]): boolean {
  return quotes.length > 0 && quotes.every((quote) => !quote.marketOpen && !quote.isStale);
}
