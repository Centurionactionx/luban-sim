import {
  assertRequestAllowed,
  MARKET_SYMBOL_PATTERN,
  normalizeMarketSymbol,
  removeFromWatchlist,
} from "@/lib";

import {
  ApiError,
  handleRouteError,
  json,
  requireAuthenticatedUser,
  requireTrustedOrigin,
} from "../../_lib/http";

export const dynamic = "force-dynamic";

/** Removes a symbol from the caller's shared watchlist. Any teammate may. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ symbol: string }> },
): Promise<Response> {
  try {
    requireTrustedOrigin(request);
    const user = await requireAuthenticatedUser();
    assertRequestAllowed(`watchlist:${user.id}`, 30);
    const { symbol: rawSymbol } = await params;
    const symbol = normalizeMarketSymbol(decodeURIComponent(rawSymbol));
    if (!MARKET_SYMBOL_PATTERN.test(symbol)) {
      throw new ApiError(400, "INVALID_SYMBOL", "Enter a valid ticker symbol.", "symbol");
    }

    return json({
      ok: true,
      watchlist: await removeFromWatchlist({ actorUserId: user.id, symbol }),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
