import { timingSafeEqual } from "node:crypto";

import { hasOpenWorkingOrders, runWorkingOrders } from "@/lib";

import { handleRouteError, json } from "../../_lib/http";

export const dynamic = "force-dynamic";
// A run fetches one quote per symbol with waiting orders; leave room.
export const maxDuration = 60;

/**
 * The price checker, called every minute by Supabase pg_cron (see
 * scripts/working-orders-cron.sql). It needs `Authorization: Bearer
 * <CRON_SECRET>`; without CRON_SECRET configured it refuses every call.
 */
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(header);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function handle(request: Request): Promise<Response> {
  try {
    if (!authorized(request)) {
      return json(
        { error: { code: "UNAUTHORIZED", message: "Not authorized." } },
        { status: 401 },
      );
    }
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
