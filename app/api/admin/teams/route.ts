import { z } from "zod";

import { createCompetitionTeam, MAX_TEAM_NAME_LENGTH } from "@/lib";

import {
  handleRouteError,
  json,
  parseJson,
  requireHostUser,
  requireTrustedOrigin,
} from "../../_lib/http";

export const dynamic = "force-dynamic";

const createTeamSchema = z
  .object({
    name: z.string().trim().min(1, "Enter a team name.").max(MAX_TEAM_NAME_LENGTH),
  })
  .strict();

export async function POST(request: Request): Promise<Response> {
  try {
    requireTrustedOrigin(request);
    const user = await requireHostUser();
    const { name } = createTeamSchema.parse(await parseJson(request));
    const overview = await createCompetitionTeam({ actorUserId: user.id, name });

    return json({ ok: true, ...overview }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
