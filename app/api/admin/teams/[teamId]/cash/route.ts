import { z } from "zod";

import { MAX_TEAM_CASH_CENTS } from "@/lib";
import {
  refreshAllRuntimeQuotes,
  setRuntimeTeamCash,
} from "@/lib/server/runtime";

import {
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
    const user = await requireHostUser();
    const { teamId: rawTeamId } = await context.params;
    const teamId = rawTeamId.trim();

    if (!teamId || teamId.length > 100) {
      throw new ApiError(400, "INVALID_TEAM_ID", "teamId is invalid.", "teamId");
    }

    const { cashCents } = cashSchema.parse(await parseJson(request));
    await refreshAllRuntimeQuotes();
    const overview = await setRuntimeTeamCash({
      actorUserId: user.id,
      teamId,
      cashCents,
    });

    return json({ ok: true, ...overview });
  } catch (error) {
    return handleRouteError(error);
  }
}
