import { assertRequestAllowed, cancelWorkingOrder } from "@/lib";

import {
  ApiError,
  handleRouteError,
  json,
  requireAuthenticatedUser,
  requireTrustedOrigin,
} from "../../_lib/http";

export const dynamic = "force-dynamic";

/** Cancel a waiting order. Any teammate may cancel the team's orders. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    requireTrustedOrigin(request);
    const user = await requireAuthenticatedUser();
    assertRequestAllowed(`working-cancel:${user.id}`, 60);
    const { id } = await params;
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) {
      throw new ApiError(404, "WORKING_ORDER_NOT_FOUND", "That order isn't one of your team's.");
    }

    return json({
      ok: true,
      workingOrder: await cancelWorkingOrder({ actorUserId: user.id, workingOrderId: id }),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
