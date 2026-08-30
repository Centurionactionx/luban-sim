import { getDb, getDbEngine } from "@/lib/server/db";

import { json } from "../_lib/http";

export const dynamic = "force-dynamic";

/**
 * Unauthenticated liveness probe: which database engine is configured and
 * whether a round trip works. The failure branch reports only a coarse error
 * class — never the driver message, which can embed the database host or
 * user — so nothing sensitive is exposed to an anonymous caller. Full detail
 * is written to the server log for the operator.
 */
export async function GET(): Promise<Response> {
  const engine = getDbEngine();

  try {
    const db = await getDb();
    const users = await db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM users",
    );

    return json({
      ok: true,
      engine,
      database: "up",
      seeded: Number(users?.count ?? 0) > 0,
    });
  } catch (error) {
    console.error("Health check database failure", error);

    return json({ ok: false, engine, database: "down" }, { status: 503 });
  }
}
