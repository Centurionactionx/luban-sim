import { watchlistSymbolsFor } from "@/lib";
import { assertMarketDataBudget, getQuoteHistories } from "@/lib/server/quotes";

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
    const histories = await getQuoteHistories(symbols, "1D");
    // A missing chart is null, and that row shows empty.
    return json({
      sparklines: Object.fromEntries(
        [...histories].map(([symbol, history]) => [
          symbol,
          history?.points.map((point) => point.closeCents) ?? null,
        ]),
      ),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
