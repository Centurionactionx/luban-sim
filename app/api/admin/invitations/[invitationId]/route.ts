import { revokeInvitation } from "@/lib";

import { requireTrustedOrigin, handleRouteError, json, requireHostUser } from "../../../_lib/http";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ invitationId: string }> },
): Promise<Response> {
  try {
    requireTrustedOrigin(request);
    const user = await requireHostUser();
    const { invitationId } = await context.params;

    return json({ invitation: await revokeInvitation(user.id, invitationId) });
  } catch (error) {
    return handleRouteError(error);
  }
}
