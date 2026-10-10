import { getDb } from "./db";

const DAY_MS = 86_400_000;

/**
 * Nightly cleanup so the free database stays far from its size cap. Deletes only
 * rows nobody reads again; orders, ledger entries, activity, snapshots, holdings,
 * teams, users and feedback are never touched. Returns how many rows each table lost.
 */
export async function pruneStaleData(now = Date.now()) {
  const before = (days: number) => new Date(now - days * DAY_MS).toISOString();
  const db = await getDb();

  // A transaction so PostgreSQL's lock and statement timeouts apply to every delete.
  return db.transaction(async (tx) => ({
    // Cache entries are served for minutes; anything older is refetched on demand.
    marketCache: (
      await tx.run("DELETE FROM market_cache WHERE fetched_at_ms < ?", [now - DAY_MS])
    ).changes,
    // A retry with a pruned key can't fill twice: orders.idempotency_key is UNIQUE.
    idempotencyRecords: (
      await tx.run("DELETE FROM idempotency_records WHERE created_at < ?", [before(7)])
    ).changes,
    // Closed without a fill. A parent stays until its exits are gone.
    workingOrders: (
      await tx.run(
        `DELETE FROM working_orders AS w
         WHERE w.status IN ('CANCELLED', 'EXPIRED')
           AND w.filled_order_id IS NULL
           AND w.updated_at < ?
           AND NOT EXISTS (SELECT 1 FROM working_orders c WHERE c.parent_id = w.id)`,
        [before(14)],
      )
    ).changes,
  }));
}
