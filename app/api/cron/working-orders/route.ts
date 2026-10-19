import { ensureWeekBaselines, hasOpenWorkingOrders, runWorkingOrders } from "@/lib";

import { handleRouteError, isCronAuthorized, json } from "../../_lib/http";

export const dynamic = "force-dynamic";
// A run fetches one quote per symbol with waiting orders; leave room.
export const maxDuration = 60;

/**
 * The price checker, called every 3 minutes on weekdays by Supabase pg_cron (see
 * scripts/working-orders-cron.sql). It needs `Authorization: Bearer
 * <CRON_SECRET>`; without CRON_SECRET configured it refuses every call.
 */
async function handle(request: Request): Promise<Response> {
  try {
    if (!isCronAuthorized(request)) {
      return json(
        { error: { code: "UNAUTHORIZED", message: "Not authorized." } },
        { status: 401 },
      );
    }
    // Saves the weekly leaderboard starting point at Monday's open; a no-op after.
    await ensureWeekBaselines().catch((error) => console.error("Weekly baseline failed", error));
    if (!(await hasOpenWorkingOrders())) {
      return json({ ok: true, idle: true });
    }
    return json({ ok: true, ...(await runWorkingOrders()) });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}
