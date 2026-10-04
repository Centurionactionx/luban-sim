import { after } from "next/server";
import { z } from "zod";

import {
  MAX_ORDER_PRICE_CENTS,
  assertRequestAllowed,
  listWorkingOrdersForUser,
  normalizeMarketSymbol,
  placeWorkingOrder,
  runWorkingOrdersIfDue,
} from "@/lib";

import {
  handleRouteError,
  json,
  parseJson,
  parseLimit,
  requireAuthenticatedUser,
  requireIdempotencyKey,
  requireTrustedOrigin,
} from "../_lib/http";

export const dynamic = "force-dynamic";

const priceCents = z.number().int().positive().max(MAX_ORDER_PRICE_CENTS);

const workingOrderSchema = z
  .object({
    orderType: z.enum(["LIMIT", "STOP_LOSS", "TAKE_PROFIT"]),
    quantity: z.number().int().positive().max(100_000),
    side: z.enum(["BUY", "SELL"]),
    symbol: z
      .string()
      .trim()
      .min(1)
      .max(16)
      .regex(/^[A-Za-z0-9.-]+$/, "Enter a valid ticker symbol.")
      .transform(normalizeMarketSymbol),
    triggerPriceCents: priceCents,
    timeInForce: z.enum(["DAY", "GTC"]),
    bracket: z
      .object({
        takeProfitCents: priceCents.nullable().optional(),
        stopLossCents: priceCents.nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** The team's waiting orders; `?closed=1` adds filled, cancelled, and expired ones. */
export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireAuthenticatedUser();
    // Its own allowance, so it never eats into the dashboard's polling.
    assertRequestAllowed(`working-list:${user.id}`, 60);
    const limit = parseLimit(request, { defaultValue: 50, maximum: 100 });
    const includeClosed = new URL(request.url).searchParams.get("closed") === "1";

    return json({
      workingOrders: await listWorkingOrdersForUser(user.id, { includeClosed, limit }),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    requireTrustedOrigin(request);
    const user = await requireAuthenticatedUser();
    const idempotencyKey = requireIdempotencyKey(request);
    const order = workingOrderSchema.parse(await parseJson(request));
    // Placing reads a quote; this stops unknown-symbol spam from reaching
    // the upstream provider. The per-person placement limit lives inside
    // placeWorkingOrder's transaction.
    assertRequestAllowed(`order-quote:${user.id}`, 30);
    const orders = await placeWorkingOrder({
      actorUserId: user.id,
      idempotencyKey,
      symbol: order.symbol,
      side: order.side,
      orderType: order.orderType,
      quantity: order.quantity,
      triggerPriceCents: order.triggerPriceCents,
      timeInForce: order.timeInForce,
      bracket: order.bracket,
    });
    // An order placed at or past the current price fills on the next check.
    // Ask for one now (at most one every 30 seconds per server) rather than
    // always waiting for the minute.
    after(runWorkingOrdersIfDue);

    return json({ ok: true, workingOrders: orders }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
