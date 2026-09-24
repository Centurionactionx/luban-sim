import { z } from "zod";

import { MAX_TEAM_CASH_CENTS, refreshAllQuotes, setTeamCash } from "@/lib";

import {
  requireTrustedOrigin,
  ApiError,
  handleRouteError,
  json,
  parseJson,
  requireHostUser,
} from "../../../../_lib/http";

export const dynamic = "force-dynamic";

const cashSchema = z
  .object({
    cashCents: z.number().int().min(0).max(MAX_TEAM_CASH_CENTS),
  })
  .strict();

export async function PATCH(
  request: Request,
  context: { params: Promise<{ teamId: string }> },
): Promise<Response> {
  try {
    requireTrustedOrigin(request);
    const user = await requireHostUser();
    const { teamId: rawTeamId } = await context.params;
    const teamId = rawTeamId.trim();

    if (!teamId || teamId.length > 100) {
      throw new ApiError(400, "INVALID_TEAM_ID", "teamId is invalid.", "teamId");
    }

    const { cashCents } = cashSchema.parse(await parseJson(request));
    // Best-effort valuation freshness only: a market-data outage must never
    // block the host from pausing, scheduling, resetting, or fixing balances.
    await refreshAllQuotes().catch(() => {});
    const overview = await setTeamCash({
      actorUserId: user.id,
      teamId,
      cashCents,
    });

    return json({ ok: true, ...overview });
  } catch (error) {
    return handleRouteError(error);
  }
}
