import { z } from "zod";

import {
  addToWatchlist,
  assertRequestAllowed,
  getWatchlist,
  normalizeMarketSymbol,
  refreshQuote,
} from "@/lib";

import {
  ApiError,
  handleRouteError,
  json,
  parseJson,
  requireAuthenticatedUser,
  requireTrustedOrigin,
} from "../_lib/http";

export const dynamic = "force-dynamic";

const addSchema = z
  .object({
    symbol: z
      .string()
      .trim()
      .min(1)
      .max(16)
      .regex(/^[A-Za-z0-9.-]+$/, "Enter a valid ticker symbol.")
      .transform(normalizeMarketSymbol),
  })
  .strict();

/** The caller's shared watchlist, priced. */
export async function GET(): Promise<Response> {
  try {
    const user = await requireAuthenticatedUser();
    return json({ watchlist: await getWatchlist(user.id) });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Adds a symbol to the caller's shared watchlist. Any teammate may. */
export async function POST(request: Request): Promise<Response> {
  try {
    requireTrustedOrigin(request);
    const user = await requireAuthenticatedUser();
    assertRequestAllowed(`watchlist:${user.id}`, 30);
    const { symbol } = addSchema.parse(await parseJson(request));
    // Looking the symbol up lists it in the simulator if it is new here.
    const quote = await refreshQuote(symbol);
    if (!quote) {
      throw new ApiError(
        404,
        "UNKNOWN_SYMBOL",
        `No market quote is available for ${symbol}.`,
        "symbol",
      );
    }

    return json(
      { ok: true, watchlist: await addToWatchlist({ actorUserId: user.id, symbol }) },
      { status: 201 },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
