import {
  QUOTE_RANGES,
  assertRequestAllowed,
  getQuoteHistory,
  isQuoteInterval,
  MARKET_SYMBOL_PATTERN,
  normalizeMarketSymbol,
  refreshQuote,
  type QuoteRange,
} from "@/lib";

import {
  ApiError,
  handleRouteError,
  json,
  requireAuthenticatedUser,
} from "../../_lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireAuthenticatedUser();

    // History cache misses reach the upstream provider; cap the per-person
    // miss rate the same way as quote search.
    assertRequestAllowed(`quotes:${user.id}`, 60);

    const searchParams = new URL(request.url).searchParams;
    const rawSymbol = searchParams.get("symbol")?.trim();
    const symbol = rawSymbol ? normalizeMarketSymbol(rawSymbol) : undefined;
    const rangeValue = searchParams.get("range")?.trim().toUpperCase() ?? "1D";
    const intervalValue = searchParams.get("interval")?.trim() || null;
    const from = searchParams.get("from")?.trim() || null;
    const to = searchParams.get("to")?.trim() || null;
    // A from/to pair asks for a custom window and overrides any range.
    const custom = from !== null || to !== null;

    if (!symbol || !MARKET_SYMBOL_PATTERN.test(symbol)) {
      throw new ApiError(
        400,
        "INVALID_SYMBOL",
        "symbol is required and must be a valid ticker.",
        "symbol",
      );
    }
    if (!custom && !QUOTE_RANGES.includes(rangeValue as QuoteRange)) {
      throw new ApiError(
        400,
        "INVALID_QUOTE_RANGE",
        "range must be 1D, 5D, 1M, or 3M.",
        "range",
      );
    }

    if (intervalValue !== null && !isQuoteInterval(intervalValue)) {
      throw new ApiError(
        400,
        "INVALID_QUOTE_INTERVAL",
        "interval must be 1m, 2m, 5m, 15m, 30m, 60m, 1d, or 1wk.",
        "interval",
      );
    }
    if (custom && (from === null || to === null)) {
      throw new ApiError(
        400,
        "INVALID_QUOTE_WINDOW",
        "A custom window needs both from and to dates.",
        from === null ? "from" : "to",
      );
    }

    const quote = await refreshQuote(symbol);
    if (!quote) {
      throw new ApiError(
        404,
        "UNKNOWN_SYMBOL",
        `The symbol ${symbol} is not available in this simulation.`,
        "symbol",
      );
    }
    const history = await getQuoteHistory(
      symbol,
      custom ? "CUSTOM" : (rangeValue as QuoteRange),
      undefined,
      { interval: intervalValue, from, to },
    );
    return json({ quote, history });
  } catch (error) {
    return handleRouteError(error);
  }
}
