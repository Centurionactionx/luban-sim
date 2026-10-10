import { z } from "zod";

import { clearAnnouncement, setAnnouncement } from "@/lib";

import {
  requireTrustedOrigin,
  handleRouteError,
  json,
  parseJson,
  requireHostUser,
} from "../../_lib/http";

export const dynamic = "force-dynamic";

const announcementSchema = z
  .object({
    title: z.string().max(200),
    body: z.string().max(2_000),
    tone: z.enum(["normal", "urgent"]),
  })
  .strict();

/** Posts or replaces the competition's announcement. */
export async function PUT(request: Request): Promise<Response> {
  try {
    requireTrustedOrigin(request);
    const user = await requireHostUser();
    const input = announcementSchema.parse(await parseJson(request));
    return json({ announcement: await setAnnouncement({ actorUserId: user.id, ...input }) });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    requireTrustedOrigin(request);
    const user = await requireHostUser();
    await clearAnnouncement(user.id);
    return json({ announcement: null });
  } catch (error) {
    return handleRouteError(error);
  }
}
