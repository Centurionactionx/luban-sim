import { z } from "zod";

import {
  deleteAccount,
  setAccountRole,
  setAccountStatus,
  setAccountTeam,
} from "@/lib";

import {
  handleRouteError,
  json,
  parseJson,
  requireHostUser,
} from "../../../_lib/http";

export const dynamic = "force-dynamic";

const updateSchema = z
  .object({
    status: z.enum(["active", "suspended"]).optional(),
    role: z.enum(["student", "host", "platform_admin"]).optional(),
    teamId: z.string().trim().min(1).max(100).nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.status !== undefined ||
      value.role !== undefined ||
      value.teamId !== undefined,
    { message: "Provide a status, role, or team change." },
  );

export async function PATCH(
  request: Request,
  context: { params: Promise<{ userId: string }> },
): Promise<Response> {
  try {
    const user = await requireHostUser();
    const { userId } = await context.params;
    const update = updateSchema.parse(await parseJson(request));

    let account;

    if (update.role !== undefined) {
      account = await setAccountRole(user.id, userId, update.role);
    }
    if (update.teamId !== undefined) {
      account = await setAccountTeam(user.id, userId, update.teamId);
    }
    if (update.status !== undefined) {
      account = await setAccountStatus(user.id, userId, update.status);
    }

    return json({ account });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ userId: string }> },
): Promise<Response> {
  try {
    const user = await requireHostUser();
    const { userId } = await context.params;

    return json({ result: await deleteAccount(user.id, userId) });
  } catch (error) {
    return handleRouteError(error);
  }
}
