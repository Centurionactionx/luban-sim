import { getDb } from "@/lib/server/db";
import { z } from "zod";

import {
  deleteAccount,
  setAccountRole,
  setAccountStatus,
  setAccountTeam,
} from "@/lib";

import {
  requireTrustedOrigin,
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
    requireTrustedOrigin(request);
    const user = await requireHostUser();
    const { userId } = await context.params;
    const update = updateSchema.parse(await parseJson(request));

    const db = await getDb();
    const account = await db.transaction(async () => {
      let updatedAccount;

      if (update.role !== undefined) {
        updatedAccount = await setAccountRole(user.id, userId, update.role);
      }
      if (update.teamId !== undefined) {
        updatedAccount = await setAccountTeam(user.id, userId, update.teamId);
      }
      if (update.status !== undefined) {
        updatedAccount = await setAccountStatus(user.id, userId, update.status);
      }

      return updatedAccount;
    });

    return json({ account });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ userId: string }> },
): Promise<Response> {
  try {
    requireTrustedOrigin(request);
    const user = await requireHostUser();
    const { userId } = await context.params;

    return json({ result: await deleteAccount(user.id, userId) });
  } catch (error) {
    return handleRouteError(error);
  }
}
