import { z } from "zod";

import {
  MAX_TEAM_NAME_LENGTH,
  refreshAllQuotes,
  removeCompetitionTeam,
  renameCompetitionTeam,
  setTeamStatus,
} from "@/lib";

import {
  requireTrustedOrigin,
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

const renameSchema = z
  .object({
    name: z.string().trim().min(1, "Enter a team name.").max(MAX_TEAM_NAME_LENGTH),
  })
  .strict();

const mutationSchema = z.union([statusSchema, renameSchema]);

function normalizeTeamId(rawTeamId: string): string {
  const teamId = rawTeamId.trim();

  if (!teamId || teamId.length > 100) {
    throw new ApiError(400, "INVALID_TEAM_ID", "teamId is invalid.", "teamId");
  }

  return teamId;
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ teamId: string }> },
): Promise<Response> {
  try {
    requireTrustedOrigin(request);
    const user = await requireHostUser();
    const { teamId: rawTeamId } = await context.params;
    const teamId = normalizeTeamId(rawTeamId);
    const mutation = mutationSchema.parse(await parseJson(request));
    let overview;

    if ("status" in mutation) {
      // Best-effort valuation freshness only: a market-data outage must never
      // block the host from changing competition controls.
      await refreshAllQuotes().catch(() => {});
      overview = await setTeamStatus({
        actorUserId: user.id,
        status: mutation.status,
        teamId,
      });
    } else {
      overview = await renameCompetitionTeam({
        actorUserId: user.id,
        name: mutation.name,
        teamId,
      });
    }

    return json({ ok: true, ...overview });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ teamId: string }> },
): Promise<Response> {
  try {
    requireTrustedOrigin(request);
    const user = await requireHostUser();
    const { teamId: rawTeamId } = await context.params;
    const teamId = normalizeTeamId(rawTeamId);
    const overview = await removeCompetitionTeam({
      actorUserId: user.id,
      teamId,
    });

    return json({ ok: true, ...overview });
  } catch (error) {
    return handleRouteError(error);
  }
}
