import {
  assertRequestAllowed,
  getDashboard,
  recordPortfolioSnapshot,
  isDemoLoginAllowed,
  listDemoUsers,
  refreshAllQuotes,
  refreshMissingQuotes,
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
    // Each dashboard read recomputes the whole leaderboard; cap how fast one
    // client can force that work. Well above any legitimate polling cadence.
    assertRequestAllowed(`poll:${user.id}`, 120);
    const refreshMarket =
      new URL(request.url).searchParams.get("refreshMarket") !== "0";
    // Light polls skip the market refresh but must still price any holding
    // this server instance has never quoted, or valuing it would fail.
    if (refreshMarket) await refreshAllQuotes();
    else await refreshMissingQuotes();
    const dashboard = await getDashboard(user.id);
    // Feeds the portfolio history chart; at most one row per team every two
    // hours. A failed write must never cost the person their dashboard.
    if (dashboard.team && dashboard.portfolio) {
      await recordPortfolioSnapshot(
        dashboard.team.id,
        dashboard.portfolio.totalValueCents,
      ).catch(() => {});
    }

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
