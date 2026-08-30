import {
  getDashboard,
  isDemoLoginAllowed,
  listDemoUsers,
  refreshAllQuotes,
} from "@/lib";

import {
  handleRouteError,
  json,
  requireAuthenticatedUser,
} from "../_lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireAuthenticatedUser();
    const refreshMarket =
      new URL(request.url).searchParams.get("refreshMarket") !== "0";
    if (refreshMarket) await refreshAllQuotes();
    const dashboard = await getDashboard(user.id);

    return json({
      ...dashboard,
      session: {
        user,
        demoUsers: isDemoLoginAllowed() ? await listDemoUsers() : [],
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
