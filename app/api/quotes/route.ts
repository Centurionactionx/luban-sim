import {
  normalizeMarketSymbol,
} from "@/lib";
import {
  listRuntimeQuotes,
  refreshAllRuntimeQuotes,
  refreshRuntimeQuote,
  searchRuntimeMarketInstruments,
} from "@/lib/server/runtime";

import {
  ApiError,
  handleRouteError,
  json,
  requireAuthenticatedUser,
} from "../_lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    await requireAuthenticatedUser();

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

      const quote = await refreshRuntimeQuote(symbol);
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

      return json({ results: await searchRuntimeMarketInstruments(query) });
    }

    await refreshAllRuntimeQuotes();
    return json({ results: (await listRuntimeQuotes()).slice(0, 25) });
  } catch (error) {
    return handleRouteError(error);
  }
}
