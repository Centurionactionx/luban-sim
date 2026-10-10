import {
  getPopularInstruments,
  listQuotes,
  MARKET_SYMBOL_PATTERN,
  normalizeMarketSymbol,
  refreshAllQuotes,
  refreshQuote,
  searchMarketInstruments,
  withBuyRules,
} from "@/lib";
import { assertMarketDataBudget } from "@/lib/server/quotes";

import {
  ApiError,
  handleRouteError,
  json,
  requireAuthenticatedUser,
} from "../_lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireAuthenticatedUser();

    // Every branch below can reach the market data provider on a cache miss.
    assertMarketDataBudget(user.id);

    const searchParams = new URL(request.url).searchParams;

    // Search results aren't personal, so the browser may reuse them for a
    // few minutes: repeating a search, even after a reload, is instant.
    // Expires and Pragma are cleared so the default no-store values don't
    // contradict max-age.
    const searchCache = {
      "Cache-Control": "private, max-age=300",
      Expires: new Date(Date.now() + 300_000).toUTCString(),
      Pragma: "",
    };

    if (searchParams.has("popular")) {
      return json(
        { sections: await getPopularInstruments() },
        { headers: searchCache },
      );
    }
    const rawSymbol = searchParams.get("symbol")?.trim();
    const symbol = rawSymbol ? normalizeMarketSymbol(rawSymbol) : undefined;
    const query = (searchParams.get("q") ?? searchParams.get("query"))?.trim();

    if (symbol && query) {
      throw new ApiError(
        400,
        "AMBIGUOUS_QUERY",
        "Provide either symbol or q, not both.",
      );
    }

    if (symbol) {
      if (!MARKET_SYMBOL_PATTERN.test(symbol)) {
        throw new ApiError(
          400,
          "INVALID_SYMBOL",
          "symbol is not a valid ticker.",
          "symbol",
        );
      }

      const quote = await refreshQuote(symbol);
      return json({ results: quote ? [withBuyRules(quote)] : [] });
    }

    if (query !== undefined) {
      if (!query || query.length > 80) {
        throw new ApiError(
          400,
          "INVALID_QUERY",
          "q must contain between 1 and 80 characters.",
          "q",
        );
      }

      return json(
        { results: await searchMarketInstruments(query) },
        { headers: searchCache },
      );
    }

    await refreshAllQuotes();
    return json({ results: (await listQuotes()).slice(0, 25).map(withBuyRules) });
  } catch (error) {
    return handleRouteError(error);
  }
}
