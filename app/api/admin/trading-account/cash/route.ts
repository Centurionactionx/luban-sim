import { z } from "zod";

import {
  MAX_ADMIN_TRADING_CASH_CENTS,
  setAdminTradingCash,
} from "@/lib";

import {
  requireTrustedOrigin,
  handleRouteError,
  json,
  parseJson,
  requirePlatformAdmin,
} from "../../../_lib/http";

export const dynamic = "force-dynamic";

const cashSchema = z
  .object({
    cashCents: z.number().int().min(0).max(MAX_ADMIN_TRADING_CASH_CENTS),
  })
  .strict();

export async function PATCH(request: Request): Promise<Response> {
  try {
    requireTrustedOrigin(request);
    const user = await requirePlatformAdmin();
    const { cashCents } = cashSchema.parse(await parseJson(request));
    const account = await setAdminTradingCash({
      actorUserId: user.id,
      cashCents,
    });

    return json({ ok: true, account });
  } catch (error) {
    return handleRouteError(error);
  }
}
