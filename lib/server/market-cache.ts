import { getDb } from "./db";

export interface SharedCacheEntry {
  payload: string;
  fetchedAtMs: number;
}

/**
 * Market data every server instance can see. Serverless instances keep their
 * own memory, so without this each one fetched the same prices from Yahoo;
 * with it, the first instance to fetch a symbol saves it and the rest reuse it
 * until it expires. Every call fails soft: a database hiccup only means an
 * extra upstream fetch, never a broken page.
 */
export interface SharedMarketCache {
  read(keys: string[]): Promise<Map<string, SharedCacheEntry>>;
  write(key: string, payload: string, fetchedAtMs: number): Promise<void>;
}

/** Largest batch read in one query; far above one dashboard's needs. */
const MAX_KEYS_PER_READ = 500;

export const databaseMarketCache: SharedMarketCache = {
  async read(keys) {
    const entries = new Map<string, SharedCacheEntry>();
    const unique = [...new Set(keys)].slice(0, MAX_KEYS_PER_READ);
    if (unique.length === 0) return entries;
    try {
      const db = await getDb();
      const rows = await db.all<{
        cache_key: string;
        payload: string;
        fetched_at_ms: number;
      }>(
        `SELECT cache_key, payload, fetched_at_ms
         FROM market_cache
         WHERE cache_key IN (${unique.map(() => "?").join(", ")})`,
        unique,
      );
      for (const row of rows) {
        entries.set(row.cache_key, {
          payload: row.payload,
          fetchedAtMs: Number(row.fetched_at_ms),
        });
      }
    } catch {
      // Fall back to this instance's own memory.
    }
    return entries;
  },

  async write(key, payload, fetchedAtMs) {
    try {
      const db = await getDb();
      // Never let an older fetch overwrite a newer one from another instance.
      await db.run(
        `INSERT INTO market_cache (cache_key, payload, fetched_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT (cache_key) DO UPDATE SET
           payload = excluded.payload,
           fetched_at_ms = excluded.fetched_at_ms
         WHERE market_cache.fetched_at_ms < excluded.fetched_at_ms`,
        [key, payload, fetchedAtMs],
      );
    } catch {
      // The fetched value is still served from memory.
    }
  },
};
