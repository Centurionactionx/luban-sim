import { getDb, getDbEngine } from "@/lib/server/db";

import { json } from "../_lib/http";

export const dynamic = "force-dynamic";

/**
 * Unauthenticated liveness probe: which database engine is configured and
 * whether a round trip works. Reports only the error class and message —
 * never connection details — so it is safe to expose.
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
    const message =
      error instanceof Error ? `${error.name}: ${error.message}` : "unknown";

    return json({ ok: false, engine, database: "down", error: message }, {
      status: 503,
    });
  }
}
