import { z } from "zod";

import {
  clearAdminValuationPortfolio,
  createAdminValuationPosition,
  getAdminValuationPortfolio,
} from "@/lib/server/admin-valuation";

import {
  handleRouteError,
  json,
  parseJson,
  requireIdempotencyKey,
  requirePlatformAdmin,
} from "../../_lib/http";

export const dynamic = "force-dynamic";

const createPositionSchema = z
  .object({
    symbol: z
      .string()
      .trim()
      .min(1)
      .max(16)
      .regex(/^[A-Za-z0-9.-]+$/, "Enter a valid ticker symbol."),
    quantity: z.number().int().positive().max(100_000),
    purchaseDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a valid historical date."),
  })
  .strict();

export async function GET(): Promise<Response> {
  try {
    const user = await requirePlatformAdmin();
    return json(await getAdminValuationPortfolio(user.id));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requirePlatformAdmin();
    const idempotencyKey = requireIdempotencyKey(request);
    const input = createPositionSchema.parse(await parseJson(request));
    const portfolio = await createAdminValuationPosition({
      actorUserId: user.id,
      idempotencyKey,
      ...input,
    });
    return json(portfolio, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(): Promise<Response> {
  try {
    const user = await requirePlatformAdmin();
    return json(await clearAdminValuationPortfolio(user.id));
  } catch (error) {
    return handleRouteError(error);
  }
}
