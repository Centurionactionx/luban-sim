import {
  assertRequestAllowed,
  listQuotes,
  normalizeMarketSymbol,
  refreshAllQuotes,
  refreshQuote,
  searchMarketInstruments,
} from "@/lib";

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

    // Cache misses on search and symbol resolution reach the upstream
    // provider, so cap how fast one person can generate them.
    assertRequestAllowed(`quotes:${user.id}`, 60);

    const searchParams = new URL(request.url).searchParams;
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
      if (!/^[A-Z0-9.-]{1,16}$/.test(symbol)) {
        throw new ApiError(
          400,
          "INVALID_SYMBOL",
          "symbol is not a valid ticker.",
          "symbol",
        );
      }

      const quote = await refreshQuote(symbol);
      return json({ results: quote ? [quote] : [] });
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

      return json({ results: await searchMarketInstruments(query) });
    }

    await refreshAllQuotes();
    return json({ results: listQuotes().slice(0, 25) });
  } catch (error) {
    return handleRouteError(error);
  }
}
