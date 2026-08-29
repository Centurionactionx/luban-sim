import {
  getRuntimeAdminOverview,
  refreshAllRuntimeQuotes,
} from "@/lib/server/runtime";

import {
  handleRouteError,
  json,
  requireHostUser,
} from "../../_lib/http";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const user = await requireHostUser();
    await refreshAllRuntimeQuotes();
    return json(await getRuntimeAdminOverview(user.id));
  } catch (error) {
    return handleRouteError(error);
  }
}
