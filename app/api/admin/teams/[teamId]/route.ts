import { z } from "zod";

import {
  refreshAllRuntimeQuotes,
  setRuntimeTeamStatus,
} from "@/lib/server/runtime";

import {
  ApiError,
  handleRouteError,
  json,
  parseJson,
  requireHostUser,
} from "../../../_lib/http";

export const dynamic = "force-dynamic";

const statusSchema = z
  .object({
    status: z.preprocess(
      (value) =>
        typeof value === "string" ? value.trim().toLowerCase() : value,
      z.enum(["active", "frozen", "disqualified"]),
    ),
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
      throw new ApiError(
        400,
        "INVALID_TEAM_ID",
        "teamId is invalid.",
        "teamId",
      );
    }

    const { status } = statusSchema.parse(await parseJson(request));
    await refreshAllRuntimeQuotes();
    const overview = await setRuntimeTeamStatus({
      actorUserId: user.id,
      status,
      teamId,
    });

    return json({ ok: true, ...overview });
  } catch (error) {
    return handleRouteError(error);
  }
}
