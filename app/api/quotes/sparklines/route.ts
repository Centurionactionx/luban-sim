import { getQuoteHistory, watchlistSymbolsFor } from "@/lib";
import { assertMarketDataBudget } from "@/lib/server/quotes";

import { handleRouteError, json, requireAuthenticatedUser } from "../../_lib/http";

export const dynamic = "force-dynamic";

/**
 * Today's closes for every symbol on the caller's watchlist in one request,
 * so the watchlist costs one invocation instead of one per row. The server
 * picks the symbols, which keeps a batch capped at the watchlist's size.
 */
export async function GET(): Promise<Response> {
  try {
    const user = await requireAuthenticatedUser();
    // History cache misses reach the upstream provider.
    assertMarketDataBudget(user.id);

    const symbols = await watchlistSymbolsFor(user.id);
    const entries = await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const history = await getQuoteHistory(symbol, "1D");
          return [symbol, history.points.map((point) => point.closeCents)] as const;
        } catch {
          // One missing chart must not blank the rest; the row shows empty.
          return [symbol, null] as const;
        }
      }),
    );
    return json({ sparklines: Object.fromEntries(entries) });
  } catch (error) {
    return handleRouteError(error);
  }
}
