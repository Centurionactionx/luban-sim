import { z } from "zod";

import {
  listOrders,
  normalizeMarketSymbol,
  placeOrder,
  refreshQuote,
  replayOrder,
} from "@/lib";

import {
  ApiError,
  handleRouteError,
  json,
  parseJson,
  parseLimit,
  requireAuthenticatedUser,
  requireIdempotencyKey,
} from "../_lib/http";

export const dynamic = "force-dynamic";

const orderSchema = z
  .object({
    orderType: z.literal("MARKET").default("MARKET"),
    quantity: z.number().int().positive().max(1_000_000),
    side: z.enum(["BUY", "SELL"]),
    symbol: z
      .string()
      .trim()
      .min(1)
      .max(16)
      .regex(/^[A-Za-z0-9.-]+$/, "Enter a valid ticker symbol.")
      .transform(normalizeMarketSymbol),
  })
  .strict();

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireAuthenticatedUser();
    const limit = parseLimit(request, { defaultValue: 25, maximum: 100 });

    return json({ orders: listOrders(user.id, limit) });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireAuthenticatedUser();
    const idempotencyKey = requireIdempotencyKey(request);
    const order = orderSchema.parse(await parseJson(request));
    const input = {
      actorUserId: user.id,
      idempotencyKey,
      quantity: order.quantity,
      side: order.side,
      symbol: order.symbol,
    };
    const replay = replayOrder(input);
    if (replay) {
      return json({ ok: true, ...replay }, { status: 201 });
    }
    const quote = await refreshQuote(order.symbol);
    if (!quote) {
      throw new ApiError(
        404,
        "UNKNOWN_SYMBOL",
        `No market quote is available for ${order.symbol}.`,
        "symbol",
      );
    }
    if (quote.isStale) {
      throw new ApiError(
        503,
        "MARKET_DATA_STALE",
        "Trading is paused because the latest market quote could not be refreshed.",
      );
    }
    const receipt = placeOrder(input);

    return json({ ok: true, ...receipt }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
