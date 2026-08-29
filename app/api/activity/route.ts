import { listActivity } from "@/lib";

import {
  handleRouteError,
  json,
  parseLimit,
  requireAuthenticatedUser,
} from "../_lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireAuthenticatedUser();
    const limit = parseLimit(request, { defaultValue: 30, maximum: 100 });

    return json({ activity: listActivity(user.id, limit) });
  } catch (error) {
    return handleRouteError(error);
  }
}
