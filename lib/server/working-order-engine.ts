import { randomUUID } from "node:crypto";

import type { AssetClass, Quote, TradeSide, WorkingOrderType } from "../contracts";
import { AppError } from "../errors";
import { acquireAccountReadLock, type DbExecutor } from "./database";
import { getDb } from "./db";
import { unitWord } from "../lots";
import { getMarketDataProvider, marketDataNow, refreshQuote } from "./quotes";
import { maxPositionPercent, maxQuoteAgeMs, placeOrder } from "./trading";
import { stockSessionMayBeOpen } from "../market-calendar";
import { MAX_DISTINCT_HOLDINGS_PER_TEAM } from "../order-math";
import {
  workingOrderTriggered,
  workingOrdersAvailableTo,
} from "./working-order-book";
import { workingOrderLabel } from "./working-orders";

/**
 * The price checker. Each run expires and cancels what is due, then fills
 * every waiting order whose price has been reached. It runs every minute from
 * Supabase pg_cron (POST /api/cron/working-orders) and, as a backup, after
 * dashboard loads. Runs may overlap freely: a fill re-checks, under the team
 * lock and before any money moves, that its order is still waiting, so each
 * order fills at most once.
 */

/** Symbols whose quotes are fetched at the same time in one run. */
const QUOTE_CONCURRENCY = 6;

/** No new symbol starts after this, so a run ends inside the cron route's 60 s. */
const RUN_DEADLINE_MS = 45_000;

export interface WorkingOrderRunReport {
  checked: number;
  filled: number;
  cancelled: number;
  expired: number;
  skippedSymbols: string[];
}

interface OpenOrderRow {
  id: string;
  team_id: string;
  actor_user_id: string;
  actor_role: string | null;
  symbol: string;
  asset_class: AssetClass | null;
  side: TradeSide;
  order_type: WorkingOrderType;
  quantity: number;
  trigger_price_cents: number;
  status: "WORKING" | "PENDING_PARENT";
  expires_at: string | null;
  parent_id: string | null;
  oco_group_id: string | null;
  sandbox_owner_user_id: string | null;
  team_status: string;
  competition_status: string | null;
  competition_starts_at: string | null;
  competition_ends_at: string | null;
}

/**
 * Problems that may clear by the next run (closed market, old price, a
 * write race, a frozen team): leave the order waiting. Server-side errors
 * also wait (and are logged) rather than cancel a student's order. Anything
 * else cancels the order with a plain reason, because retrying can't succeed.
 */
const TRANSIENT_CODES = new Set([
  "MARKET_CLOSED",
  "MARKET_DATA_STALE",
  "MARKET_DATA_UNAVAILABLE",
  "MARKET_DATA_TIMEOUT",
  "MARKET_DATA_RATE_LIMITED",
  "TRADING_HALTED",
  "PORTFOLIO_CONFLICT",
  "TRADING_CLOSED",
  "TEAM_NOT_ACTIVE",
  "WORKING_ORDER_NOT_WAITING",
  "WORKING_ORDER_PRICE_MOVED",
]);

function cancellationReason(error: AppError): string {
  switch (error.code) {
    case "INSUFFICIENT_CASH":
      return "Not enough cash when the price was reached.";
    case "INSUFFICIENT_SHARES":
      return "The team no longer held enough shares when the price was reached.";
    case "WORKING_ORDER_TEAM_CHANGED":
    case "TEAM_REQUIRED":
      return "The person who placed it is no longer on the team.";
    case "ACCOUNT_SUSPENDED":
      return "The account that placed it is suspended.";
    case "ASSET_CLASS_DISABLED":
    case "SYMBOL_BLOCKED":
      return "This listing can no longer be bought.";
    case "POSITION_LIMIT":
      return `Filling it would have put more than ${maxPositionPercent()}% of the portfolio in one holding.`;
    case "HOLDINGS_LIMIT":
      return `The team already held ${MAX_DISTINCT_HOLDINGS_PER_TEAM} different stocks when the price was reached.`;
    case "LOT_TOO_SMALL":
      return "One lot became worth less than $1, so buys are paused.";
    default:
      return error.message;
  }
}

async function lockTeam(tx: DbExecutor, teamId: string): Promise<void> {
  await acquireAccountReadLock(tx);
  if (tx.engine === "postgres") {
    await tx.all("SELECT id FROM teams WHERE id = ? FOR UPDATE", [teamId]);
  }
}

/**
 * Close an open order (and any bracket exits still waiting on it) with a
 * final status. Returns false when it was no longer open, e.g. another run
 * already handled it. Must run under the team lock.
 */
async function closeOrder(
  tx: DbExecutor,
  id: string,
  status: "CANCELLED" | "EXPIRED",
  reason: string,
  nowIso: string,
): Promise<boolean> {
  const result = await tx.run(
    `UPDATE working_orders
     SET status = ?, status_reason = ?, updated_at = ?
     WHERE id = ? AND status IN ('WORKING', 'PENDING_PARENT')`,
    [status, reason, nowIso, id],
  );
  if (result.changes !== 1) return false;
  await tx.run(
    `UPDATE working_orders
     SET status = ?, status_reason = ?, updated_at = ?
     WHERE parent_id = ? AND status = 'PENDING_PARENT'`,
    [status, `${reason} (with the buy it was attached to)`, nowIso, id],
  );
  return true;
}

async function logActivity(
  tx: DbExecutor,
  order: OpenOrderRow,
  type: "WORKING_ORDER_CANCELLED" | "WORKING_ORDER_EXPIRED",
  detail: string,
  nowIso: string,
): Promise<void> {
  const team = await tx.get<{ competition_id: string }>(
    "SELECT competition_id FROM teams WHERE id = ?",
    [order.team_id],
  );
  if (!team) return;
  const label = workingOrderLabel(order.order_type, order.side);
  await tx.run(
    `INSERT INTO activity_events (
       id, competition_id, team_id, actor_user_id, type, title, detail, created_at
     ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
    [
      randomUUID(),
      team.competition_id,
      order.team_id,
      type,
      `${label} ${order.symbol} ${type === "WORKING_ORDER_EXPIRED" ? "expired" : "cancelled"}`,
      `${label} for ${Number(order.quantity)} ${unitWord(order.asset_class ?? "STOCK", Number(order.quantity))} of ${order.symbol}: ${detail}`,
      nowIso,
    ],
  );
}

/**
 * Closes orders in one pass, logging one activity entry per thing a person
 * placed: an order closed with its buy is covered by the buy's entry, and a
 * bracket's two exits share one entry.
 */
class Closer {
  private readonly closed = new Set<string>();
  private readonly loggedGroups = new Set<string>();
  count = 0;

  async close(
    order: OpenOrderRow,
    status: "CANCELLED" | "EXPIRED",
    reason: string,
    nowIso: string,
  ): Promise<boolean> {
    const db = await getDb();
    const ok = await db.transaction(async (tx) => {
      await lockTeam(tx, order.team_id);
      const done = await closeOrder(tx, order.id, status, reason, nowIso);
      if (!done) return false;
      const coveredByParent = order.parent_id !== null && this.closed.has(order.parent_id);
      const coveredByPartner =
        order.oco_group_id !== null && this.loggedGroups.has(order.oco_group_id);
      if (!coveredByParent && !coveredByPartner) {
        await logActivity(
          tx,
          order,
          status === "EXPIRED" ? "WORKING_ORDER_EXPIRED" : "WORKING_ORDER_CANCELLED",
          reason,
          nowIso,
        );
        if (order.oco_group_id) this.loggedGroups.add(order.oco_group_id);
      }
      return true;
    });
    if (ok) {
      this.closed.add(order.id);
      this.count += 1;
    }
    return ok;
  }
}

async function readOpenOrders(): Promise<OpenOrderRow[]> {
  const db = await getDb();
  // Orders a person placed come before exits attached to them, so closing a
  // buy takes its waiting exits with it.
  return db.all<OpenOrderRow>(
    `SELECT w.id, w.team_id, w.actor_user_id, u.role AS actor_role, w.symbol,
            i.asset_class, w.side, w.order_type, w.quantity, w.trigger_price_cents,
            w.status, w.expires_at, w.parent_id, w.oco_group_id,
            t.sandbox_owner_user_id, t.status AS team_status,
            c.status AS competition_status, c.starts_at AS competition_starts_at,
            c.ends_at AS competition_ends_at
     FROM working_orders AS w
     JOIN teams AS t ON t.id = w.team_id
     JOIN instruments AS i ON i.symbol = w.symbol
     LEFT JOIN users AS u ON u.id = w.actor_user_id
     LEFT JOIN competitions AS c ON c.id = t.competition_id
     WHERE w.status IN ('WORKING', 'PENDING_PARENT')
     ORDER BY CASE WHEN w.parent_id IS NULL THEN 0 ELSE 1 END, w.created_at ASC, w.id ASC`,
  );
}

function competitionOver(order: OpenOrderRow, nowIso: string): boolean {
  if (order.sandbox_owner_user_id) return false;
  return (
    order.competition_status === "ended" ||
    (order.competition_ends_at !== null && order.competition_ends_at <= nowIso)
  );
}

/** Whether the team may trade right now; the admin sandbox always may. */
function teamCanTrade(order: OpenOrderRow, nowIso: string): boolean {
  if (order.sandbox_owner_user_id) return true;
  return (
    order.team_status === "active" &&
    order.competition_status === "active" &&
    (!order.competition_starts_at || nowIso >= order.competition_starts_at) &&
    (!order.competition_ends_at || nowIso < order.competition_ends_at)
  );
}

/** A quote fit to fill against: fresh, tradable, and its market open. */
function usableQuote(quote: Quote | null, now: Date): quote is Quote {
  if (!quote || quote.isStale || quote.tradingHaltReason) return false;
  const age = now.getTime() - Date.parse(quote.asOf);
  if (!Number.isFinite(age) || age > maxQuoteAgeMs()) return false;
  return (
    quote.marketOpen &&
    (quote.marketClosesAt === null || now.getTime() < Date.parse(quote.marketClosesAt))
  );
}

type FillOutcome = "filled" | "replayed" | "cancelled" | "waiting";

async function fillOrder(
  order: OpenOrderRow,
  quote: Quote,
  now: Date,
  closer: Closer,
): Promise<FillOutcome> {
  const label = workingOrderLabel(order.order_type, order.side);
  // One key per order per minute: a rerun within the minute replays, and a
  // transient refusal never blocks the next minute's attempt.
  const minute = Math.floor(now.getTime() / 60_000);
  const nowIso = now.toISOString();
  try {
    const receipt = await placeOrder(
      {
        actorUserId: order.actor_user_id,
        symbol: order.symbol,
        side: order.side,
        quantity: Number(order.quantity),
        idempotencyKey: `working:${order.id}:${minute}`,
      },
      {
        systemTriggered: true,
        // Waiting sells guard shares the team holds; they never open a short.
        closeOnly: order.side === "SELL",
        releaseWorkingOrderIds: [order.id],
        expectTeamId: order.team_id,
        activityLabel: label,
        // Fill on the very quote that triggered the order, and never on the
        // wrong side of a limit or take profit. A stop loss is a market order
        // once triggered, so it takes the price it gets.
        fillQuote: quote,
        now,
        priceLimit:
          order.order_type === "STOP_LOSS"
            ? undefined
            : { side: order.side, limitCents: Number(order.trigger_price_cents) },
        beforeFill: async (tx) => {
          const current = await tx.get<{ status: string; expires_at: string | null }>(
            "SELECT status, expires_at FROM working_orders WHERE id = ?",
            [order.id],
          );
          if (
            current?.status !== "WORKING" ||
            (current.expires_at !== null && current.expires_at <= nowIso)
          ) {
            throw new AppError(
              "WORKING_ORDER_NOT_WAITING",
              "This order was already filled, cancelled, or expired.",
              409,
            );
          }
        },
        afterFill: async (tx, filled) => {
          const marked = await tx.run(
            `UPDATE working_orders
             SET status = 'FILLED', filled_order_id = ?, status_reason = NULL, updated_at = ?
             WHERE id = ? AND status = 'WORKING'`,
            [filled.orderId, nowIso, order.id],
          );
          if (marked.changes !== 1) {
            // beforeFill ran under the same lock, so this can't happen; if it
            // ever did, a plain Error rolls the whole fill back.
            throw new Error(`Working order ${order.id} changed during its fill.`);
          }
          // The other exit of a bracket is no longer needed.
          if (order.oco_group_id) {
            await tx.run(
              `UPDATE working_orders
               SET status = 'CANCELLED', status_reason = ?, updated_at = ?
               WHERE oco_group_id = ? AND id <> ? AND status IN ('WORKING', 'PENDING_PARENT')`,
              [`The ${label.toLowerCase()} filled first.`, nowIso, order.oco_group_id, order.id],
            );
          }
          // A filled bracket buy starts its exits.
          await tx.run(
            `UPDATE working_orders
             SET status = 'WORKING', updated_at = ?
             WHERE parent_id = ? AND status = 'PENDING_PARENT'`,
            [nowIso, order.id],
          );
        },
      },
    );
    return receipt.duplicate ? "replayed" : "filled";
  } catch (error) {
    if (!(error instanceof AppError) || error.status >= 500) {
      console.error("Working order fill failed; it will be retried", order.id, error);
      return "waiting";
    }
    if (TRANSIENT_CODES.has(error.code)) return "waiting";
    const cancelled = await closer.close(order, "CANCELLED", cancellationReason(error), nowIso);
    return cancelled ? "cancelled" : "waiting";
  }
}

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * One pass of the price checker. Safe to call as often as wanted and from
 * several places at once.
 */
export async function runWorkingOrders(at?: Date): Promise<WorkingOrderRunReport> {
  const now = at ?? marketDataNow();
  const nowIso = now.toISOString();
  const deadline = Date.now() + RUN_DEADLINE_MS;
  const closer = new Closer();
  const report: WorkingOrderRunReport = {
    checked: 0,
    filled: 0,
    cancelled: 0,
    expired: 0,
    skippedSymbols: [],
  };

  // 1. Close what can no longer fill.
  for (const order of await readOpenOrders()) {
    if (competitionOver(order, nowIso)) {
      if (await closer.close(order, "EXPIRED", "The competition ended.", nowIso)) {
        report.expired += 1;
      }
    } else if (order.expires_at !== null && order.expires_at <= nowIso) {
      if (await closer.close(order, "EXPIRED", "It reached the end of its trading day.", nowIso)) {
        report.expired += 1;
      }
    } else if (!order.sandbox_owner_user_id && order.team_status === "disqualified") {
      if (await closer.close(order, "CANCELLED", "The team was disqualified.", nowIso)) {
        report.cancelled += 1;
      }
    } else if (!workingOrdersAvailableTo(order.actor_role ?? "")) {
      // Switching the feature off frees everything it was holding.
      if (await closer.close(order, "CANCELLED", "Waiting orders were switched off.", nowIso)) {
        report.cancelled += 1;
      }
    }
  }

  // 2. Fill what has reached its price.
  const candidates = (await readOpenOrders()).filter(
    (order) => order.status === "WORKING" && teamCanTrade(order, nowIso),
  );
  report.checked = candidates.length;
  const bySymbol = new Map<string, OpenOrderRow[]>();
  for (const order of candidates) {
    bySymbol.set(order.symbol, [...(bySymbol.get(order.symbol) ?? []), order]);
  }

  // Stocks can't fill outside their session, so don't ask Yahoo at night.
  // (Test and demo data keep no exchange hours.)
  const sessionMayBeOpen =
    getMarketDataProvider().id !== "YAHOO_FINANCE" || stockSessionMayBeOpen(now);
  const symbols = [...bySymbol.keys()].filter((symbol) => {
    const crypto = bySymbol.get(symbol)![0].asset_class === "CRYPTO";
    if (crypto || sessionMayBeOpen) return true;
    report.skippedSymbols.push(symbol);
    return false;
  });
  // Waiting stop losses first: they cap a loss. Whatever the deadline cuts
  // short is picked up by the next run.
  const hasStop = (symbol: string) =>
    bySymbol.get(symbol)!.some((order) => order.order_type === "STOP_LOSS");
  symbols.sort((a, b) => Number(hasStop(b)) - Number(hasStop(a)));
  await mapLimited(symbols, QUOTE_CONCURRENCY, async (symbol) => {
    if (Date.now() > deadline) {
      report.skippedSymbols.push(symbol);
      return;
    }
    let quote: Quote | null;
    try {
      quote = await refreshQuote(symbol, now);
    } catch {
      quote = null;
    }
    if (!usableQuote(quote, now)) {
      report.skippedSymbols.push(symbol);
      return;
    }
    for (const order of bySymbol.get(symbol)!) {
      if (
        !workingOrderTriggered(
          {
            side: order.side,
            orderType: order.order_type,
            triggerPriceCents: Number(order.trigger_price_cents),
          },
          quote.priceCents,
        )
      ) {
        continue;
      }
      const outcome = await fillOrder(order, quote, now, closer);
      if (outcome === "filled") report.filled += 1;
      if (outcome === "cancelled") report.cancelled += 1;
    }
  });
  return report;
}

const backupRunAt = { last: 0, running: false };

/**
 * The backup trigger, called after dashboard loads: at most one run every 30
 * seconds per server instance, and only when something is waiting. It keeps
 * orders filling if the cron job ever stalls.
 */
export async function runWorkingOrdersIfDue(): Promise<void> {
  const nowMs = Date.now();
  if (backupRunAt.running || nowMs - backupRunAt.last < 30_000) return;
  backupRunAt.last = nowMs;
  backupRunAt.running = true;
  try {
    if (await hasOpenWorkingOrders()) await runWorkingOrders();
  } catch (error) {
    console.error("Backup working-order run failed", error);
  } finally {
    backupRunAt.running = false;
  }
}

/** Whether any order is waiting, so callers can skip a run cheaply. */
export async function hasOpenWorkingOrders(): Promise<boolean> {
  const db = await getDb();
  const row = await db.get<{ found: number }>(
    `SELECT 1 AS found FROM working_orders
     WHERE status IN ('WORKING', 'PENDING_PARENT') LIMIT 1`,
  );
  return Boolean(row);
}
