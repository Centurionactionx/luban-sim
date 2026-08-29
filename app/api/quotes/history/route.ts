import {
  QUOTE_RANGES,
  getQuoteHistory,
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
    await requireAuthenticatedUser();
    const searchParams = new URL(request.url).searchParams;
    const rawSymbol = searchParams.get("symbol")?.trim();
    const symbol = rawSymbol ? normalizeMarketSymbol(rawSymbol) : undefined;
    const rangeValue = searchParams.get("range")?.trim().toUpperCase() ?? "1D";

    if (!symbol || !/^[A-Z0-9.-]{1,16}$/.test(symbol)) {
      throw new ApiError(
        400,
        "INVALID_SYMBOL",
        "symbol is required and must be a valid ticker.",
        "symbol",
      );
    }
    if (!QUOTE_RANGES.includes(rangeValue as QuoteRange)) {
      throw new ApiError(
        400,
        "INVALID_QUOTE_RANGE",
        "range must be 1D, 5D, 1M, or 3M.",
        "range",
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
    const history = await getQuoteHistory(symbol, rangeValue as QuoteRange);
    return json({ quote, history });
  } catch (error) {
    return handleRouteError(error);
  }
}
