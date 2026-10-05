import { z } from "zod";

import { MAX_ADMIN_TRADING_CASH_CENTS, resetAdminTradingAccount } from "@/lib";

import {
  requireTrustedOrigin,
  handleRouteError,
  json,
  parseJson,
  requirePlatformAdmin,
} from "../../../_lib/http";

export const dynamic = "force-dynamic";

const resetSchema = z
  .object({
    cashCents: z.number().int().min(0).max(MAX_ADMIN_TRADING_CASH_CENTS).optional(),
  })
  .strict();

/**
 * Empties the administrator's own private test portfolio. Competition teams
 * are never reset this way.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    requireTrustedOrigin(request);
    const user = await requirePlatformAdmin();
    const { cashCents } = resetSchema.parse(await parseJson(request));
    const account = await resetAdminTradingAccount({
      actorUserId: user.id,
      cashCents,
    });

    return json({ ok: true, account });
  } catch (error) {
    return handleRouteError(error);
  }
}
