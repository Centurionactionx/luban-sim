import type { AssetClass, Quote, WatchlistItemView } from "../contracts";
import { MAX_WATCHLIST_ITEMS } from "../contracts";
import { AppError } from "../errors";
import { getAdminTradingTeamId } from "./admin-trading";
import type { DbExecutor } from "./database";
import { getDb } from "./db";
import { requireSessionUser } from "./queries";
import { getQuotes, normalizeMarketSymbol } from "./quotes";

interface WatchlistRow {
  symbol: string;
  name: string | null;
  exchange: string | null;
  listing_currency: "CAD" | "USD" | null;
  asset_class: AssetClass | null;
  added_by_name: string | null;
  created_at: string;
}

export interface WatchlistChangeInput {
  actorUserId: string;
  symbol: string;
}

/**
 * The portfolio a person's watchlist belongs to: their team's, or a platform
 * administrator's private test portfolio. Hosts have none. Never taken from
 * request data.
 */
async function watchlistTeamIdFor(userId: string): Promise<string | null> {
  const user = await requireSessionUser(userId);
  return user.role === "platform_admin"
    ? getAdminTradingTeamId(user.id)
    : user.teamId;
}

async function requireWatchlistTeamId(userId: string): Promise<string> {
  const teamId = await watchlistTeamIdFor(userId);
  if (!teamId) {
    throw new AppError(
      "NO_PORTFOLIO",
      "Join a team (or fund your test portfolio) to keep a watchlist.",
      403,
    );
  }
  return teamId;
}

/**
 * A team's watchlist, oldest first, each symbol priced from the shared quote
 * cache. A symbol with no price right now still shows, with a null quote.
 */
export async function listWatchlist(
  teamId: string,
  at: Date = new Date(),
  executor?: DbExecutor,
): Promise<WatchlistItemView[]> {
  const db = executor ?? (await getDb());
  const rows = await db.all<WatchlistRow>(
    `SELECT w.symbol, i.name, i.exchange, i.listing_currency, i.asset_class,
            u.name AS added_by_name, w.created_at
     FROM watchlist_items w
     LEFT JOIN instruments i ON i.symbol = w.symbol
     LEFT JOIN users u ON u.id = w.added_by_user_id
     WHERE w.team_id = ?
     ORDER BY w.created_at ASC, w.symbol ASC`,
    [teamId],
  );
  // An unpriceable watchlist must never break the dashboard.
  const quotes = await getQuotes(
    rows.map((row) => row.symbol),
    at,
  ).catch(() => null);
  const items: WatchlistItemView[] = [];

  for (const row of rows) {
    const quote: Quote | null = quotes?.get(row.symbol) ?? null;
    items.push({
      symbol: row.symbol,
      name: quote?.name ?? row.name ?? row.symbol,
      exchange: quote?.exchange ?? row.exchange ?? "",
      listingCurrency: quote?.listingCurrency ?? row.listing_currency ?? "CAD",
      assetClass: quote?.assetClass ?? row.asset_class ?? "STOCK",
      addedByName: row.added_by_name,
      addedAt: row.created_at,
      quote,
    });
  }

  return items;
}

/** The symbols on the caller's watchlist, without pricing them. */
export async function watchlistSymbolsFor(userId: string): Promise<string[]> {
  const teamId = await watchlistTeamIdFor(userId);
  if (!teamId) return [];
  const db = await getDb();
  const rows = await db.all<{ symbol: string }>(
    "SELECT symbol FROM watchlist_items WHERE team_id = ?",
    [teamId],
  );
  return rows.map((row) => row.symbol);
}

/** The caller's watchlist, or an empty one when they have no portfolio. */
export async function getWatchlist(
  userId: string,
  at: Date = new Date(),
): Promise<WatchlistItemView[]> {
  const teamId = await watchlistTeamIdFor(userId);
  return teamId ? listWatchlist(teamId, at) : [];
}

/**
 * Adds a symbol to the caller's shared watchlist. The symbol must already be
 * listed (the route looks it up first). Adding one that is already there is
 * a no-op.
 */
export async function addToWatchlist(
  input: WatchlistChangeInput,
): Promise<WatchlistItemView[]> {
  const symbol = normalizeMarketSymbol(input.symbol);
  const teamId = await requireWatchlistTeamId(input.actorUserId);
  const db = await getDb();

  await db.transaction(async (tx) => {
    const instrument = await tx.get<{ symbol: string }>(
      "SELECT symbol FROM instruments WHERE symbol = ?",
      [symbol],
    );
    if (!instrument) {
      throw new AppError(
        "UNKNOWN_SYMBOL",
        `The symbol ${symbol} is not available in this simulation.`,
        404,
        { symbol },
      );
    }

    const existing = await tx.get<{ symbol: string }>(
      "SELECT symbol FROM watchlist_items WHERE team_id = ? AND symbol = ?",
      [teamId, symbol],
    );
    if (existing) {
      return;
    }

    const count = await tx.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM watchlist_items WHERE team_id = ?",
      [teamId],
    );
    if (Number(count?.count ?? 0) >= MAX_WATCHLIST_ITEMS) {
      throw new AppError(
        "WATCHLIST_FULL",
        `A watchlist can hold at most ${MAX_WATCHLIST_ITEMS} symbols. Remove one first.`,
        409,
        { maximum: MAX_WATCHLIST_ITEMS },
      );
    }

    await tx.run(
      `INSERT INTO watchlist_items (team_id, symbol, added_by_user_id, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (team_id, symbol) DO NOTHING`,
      [teamId, symbol, input.actorUserId, new Date().toISOString()],
    );
  });

  return listWatchlist(teamId);
}

/** Removes a symbol from the caller's shared watchlist. Missing is a no-op. */
export async function removeFromWatchlist(
  input: WatchlistChangeInput,
): Promise<WatchlistItemView[]> {
  const symbol = normalizeMarketSymbol(input.symbol);
  const teamId = await requireWatchlistTeamId(input.actorUserId);
  const db = await getDb();

  await db.run("DELETE FROM watchlist_items WHERE team_id = ? AND symbol = ?", [
    teamId,
    symbol,
  ]);

  return listWatchlist(teamId);
}
