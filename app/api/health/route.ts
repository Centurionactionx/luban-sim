import { getDb, getDbEngine } from "@/lib/server/db";
import { pruneStaleData } from "@/lib/server/retention";

import { isCronAuthorized, json } from "../_lib/http";

export const dynamic = "force-dynamic";

/**
 * Liveness probe. Anonymous callers get a bare `{ ok: true }` and cause no
 * database work. Only the daily Vercel cron (`Authorization: Bearer
 * <CRON_SECRET>`, which keeps the Supabase project awake) runs the real
 * query, then the nightly cleanup. Its failure branch reports only a coarse
 * error class, never the driver message, which can embed the database host or
 * user; full detail is written to the server log for the operator.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isCronAuthorized(request)) {
    return json({ ok: true });
  }

  const engine = getDbEngine();

  try {
    const db = await getDb();
    const users = await db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM users",
    );

    // A cleanup problem must not report a healthy database as down.
    const cleanup = await pruneStaleData().catch((error) => {
      console.error("Nightly cleanup failure", error);
      return "failed";
    });

    return json({
      ok: true,
      engine,
      database: "up",
      seeded: Number(users?.count ?? 0) > 0,
      cleanup,
    });
  } catch (error) {
    console.error("Health check database failure", error);

    return json({ ok: false, engine, database: "down" }, { status: 503 });
  }
}
