import { z } from "zod";

import {
  MAX_INVITATION_TTL_HOURS,
  MIN_INVITATION_TTL_HOURS,
  createInvitation,
  listInvitations,
} from "@/lib";

import {
  handleRouteError,
  json,
  parseJson,
  requireHostUser,
} from "../../_lib/http";

export const dynamic = "force-dynamic";

const createSchema = z
  .object({
    role: z.enum(["student", "host", "platform_admin"]),
    teamId: z.string().trim().min(1).max(100).optional(),
    email: z.string().trim().max(254).optional(),
    invitedName: z.string().trim().max(80).optional(),
    expiresInHours: z
      .number()
      .int()
      .min(MIN_INVITATION_TTL_HOURS)
      .max(MAX_INVITATION_TTL_HOURS)
      .optional(),
  })
  .strict();

export async function GET(): Promise<Response> {
  try {
    const user = await requireHostUser();

    return json({ invitations: await listInvitations(user.id) });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireHostUser();
    const input = createSchema.parse(await parseJson(request));

    const created = await createInvitation({
      actorUserId: user.id,
      role: input.role,
      teamId: input.teamId ?? null,
      email: input.email || null,
      invitedName: input.invitedName || null,
      expiresInHours: input.expiresInHours,
    });

    const joinUrl = new URL(created.joinPath, request.url).toString();

    return json({ ...created, joinUrl }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
