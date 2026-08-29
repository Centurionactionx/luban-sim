import { z } from "zod";

import {
  refreshAllRuntimeQuotes,
  setRuntimeCompetitionStatus,
} from "@/lib/server/runtime";

import {
  handleRouteError,
  json,
  parseJson,
  requireHostUser,
} from "../../_lib/http";

export const dynamic = "force-dynamic";

const statusSchema = z
  .object({
    status: z.preprocess(
      (value) =>
        typeof value === "string" ? value.trim().toLowerCase() : value,
      z.enum(["draft", "active", "paused", "ended"]),
    ),
  })
  .strict();

export async function PATCH(request: Request): Promise<Response> {
  try {
    const user = await requireHostUser();
    const { status } = statusSchema.parse(await parseJson(request));
    await refreshAllRuntimeQuotes();
    const overview = await setRuntimeCompetitionStatus({
      actorUserId: user.id,
      status,
    });

    return json({ ok: true, ...overview });
  } catch (error) {
    return handleRouteError(error);
  }
}
