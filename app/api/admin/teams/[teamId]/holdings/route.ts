import { z } from "zod";

import {
  getTeamHoldings,
  normalizeMarketSymbol,
  refreshMissingQuotes,
  refreshQuote,
  setTeamHolding,
} from "@/lib";

import {
  requireTrustedOrigin,
  ApiError,
  handleRouteError,
  json,
  parseJson,
  requireHostUser,
} from "../../../../_lib/http";

export const dynamic = "force-dynamic";

const holdingSchema = z
  .object({
    symbol: z
      .string()
      .trim()
      .min(1)
      .max(24)
      .regex(/^[A-Za-z0-9.-]+$/, "Enter a valid ticker symbol."),
    quantity: z.number().int().min(0).max(1_000_000_000),
  })
  .strict();

/** Sets one team's quantity in one symbol (0 removes it); cash is untouched. */
export async function PUT(
  request: Request,
  context: { params: Promise<{ teamId: string }> },
): Promise<Response> {
  try {
    requireTrustedOrigin(request);
    const user = await requireHostUser();
    const teamId = (await context.params).teamId.trim();
    if (!teamId || teamId.length > 100) {
      throw new ApiError(400, "INVALID_TEAM_ID", "teamId is invalid.", "teamId");
    }

    const body = holdingSchema.parse(await parseJson(request));
    const symbol = normalizeMarketSymbol(body.symbol);
    // Also registers a symbol the simulator has never quoted.
    const quote = await refreshQuote(symbol);
    if (!quote) {
      throw new ApiError(
        404,
        "UNKNOWN_SYMBOL",
        `No market quote is available for ${symbol}.`,
        "symbol",
      );
    }
    if (!Number.isSafeInteger(quote.priceCadCents * body.quantity)) {
      throw new ApiError(400, "HOLDING_TOO_LARGE", "That holding is too large.", "quantity");
    }

    await setTeamHolding({
      actorUserId: user.id,
      teamId,
      symbol: quote.symbol,
      quantity: body.quantity,
      priceCadCents: quote.priceCadCents,
    });
    await refreshMissingQuotes().catch(() => {});
    return json(await getTeamHoldings(user.id, teamId));
  } catch (error) {
    return handleRouteError(error);
  }
}
