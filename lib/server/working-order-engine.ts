import { randomUUID } from "node:crypto";

import type { Quote, TradeSide, WorkingOrderType } from "../contracts";
import { AppError } from "../errors";
import { acquireAccountReadLock, type DbExecutor } from "./database";
import { getDb } from "./db";
import { marketDataNow, refreshQuote } from "./quotes";
import { placeOrder } from "./trading";
import { workingOrderTriggered } from "./working-order-book";
import { workingOrderLabel } from "./working-orders";

/**
 * The price checker. Each run expires what is due, then fills every waiting
 * order whose price has been reached. It runs every minute from Supabase
 * pg_cron (POST /api/cron/working-orders) and, as a backup, after dashboard
 * loads. Runs may overlap freely: a fill re-checks, under the team lock and
 * before any money moves, that its order is still waiting, so each order
 * fills at most once.
 */

/** Same freshness bar as a manual order: no fills on an old price. */
const MAX_QUOTE_AGE_MS = 20 * 60_000;

export interface WorkingOrderRunReport {
  checked: number;
  filled: number;
  cancelled: number;
  expired: number;
  skippedSymbols: string[];
}

interface CandidateRow {
  id: string;
  team_id: string;
  actor_user_id: string;
  symbol: string;
  side: TradeSide;
  order_type: WorkingOrderType;
  quantity: number;
  trigger_price_cents: number;
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
 * write race): leave the order waiting. Anything else cancels the order with
 * a plain reason, because retrying can't succeed.
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
]);

function cancellationReason(error: AppError): string {
  switch (error.code) {
    case "INSUFFICIENT_CASH":
      return "Not enough cash when the price was reached.";
    case "INSUFFICIENT_SHARES":
      return "The team no longer held enough shares when the price was reached.";
    case "WORKING_ORDER_TEAM_CHANGED":
      return "The person who placed it is no longer on the team.";
    case "ACCOUNT_SUSPENDED":
      return "The account that placed it is suspended.";
    case "ASSET_CLASS_DISABLED":
    case "SYMBOL_BLOCKED":
      return "This listing can no longer be bought.";
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
  order: { team_id: string; actor_user_id: string; symbol: string; side: TradeSide; order_type: WorkingOrderType; quantity: number },
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
      `${label} for ${Number(order.quantity)} of ${order.symbol}: ${detail}`,
      nowIso,
    ],
  );
}

/**
 * Expire orders past their DAY close, and every open competition order once
 * the competition has ended. Admin sandbox orders only expire by the clock.
 */
async function expireDueOrders(nowIso: string): Promise<number> {
  const db = await getDb();
  const due = await db.all<CandidateRow & { expires_at: string | null }>(
    `SELECT w.id, w.team_id, w.actor_user_id, w.symbol, w.side, w.order_type,
            w.quantity, w.parent_id, w.expires_at, t.sandbox_owner_user_id,
            c.ends_at AS competition_ends_at
     FROM working_orders AS w
     JOIN teams AS t ON t.id = w.team_id
     LEFT JOIN competitions AS c ON c.id = t.competition_id
     WHERE w.status IN ('WORKING', 'PENDING_PARENT')
       AND (
         (w.expires_at IS NOT NULL AND w.expires_at <= ?)
         OR (t.sandbox_owner_user_id IS NULL AND c.ends_at IS NOT NULL AND c.ends_at <= ?)
       )
     ORDER BY w.created_at ASC`,
    [nowIso, nowIso],
  );

  let expired = 0;
  for (const order of due) {
    const competitionEnded =
      !order.sandbox_owner_user_id &&
      order.competition_ends_at !== null &&
      order.competition_ends_at <= nowIso;
    const reason = competitionEnded
      ? "The competition ended."
      : "It reached the end of its trading day.";
    const closed = await db.transaction(async (tx) => {
      await lockTeam(tx, order.team_id);
      const ok = await closeOrder(tx, order.id, "EXPIRED", reason, nowIso);
      // One entry per order a person placed; exits that expire with their
      // buy are covered by the buy's entry.
      if (ok && order.parent_id === null) {
        await logActivity(tx, order, "WORKING_ORDER_EXPIRED", reason, nowIso);
      }
      return ok;
    });
    if (closed) expired += 1;
  }
  return expired;
}

async function readCandidates(): Promise<CandidateRow[]> {
  const db = await getDb();
  return db.all<CandidateRow>(
    `SELECT w.id, w.team_id, w.actor_user_id, w.symbol, w.side, w.order_type,
            w.quantity, w.trigger_price_cents, w.parent_id, w.oco_group_id,
            t.sandbox_owner_user_id, t.status AS team_status,
            c.status AS competition_status, c.starts_at AS competition_starts_at,
            c.ends_at AS competition_ends_at
     FROM working_orders AS w
     JOIN teams AS t ON t.id = w.team_id
     LEFT JOIN competitions AS c ON c.id = t.competition_id
     WHERE w.status = 'WORKING'
     ORDER BY w.created_at ASC`,
  );
}

/** Whether the team may trade right now; the admin sandbox always may. */
function teamCanTrade(order: CandidateRow, nowIso: string): boolean {
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
  if (!Number.isFinite(age) || age > MAX_QUOTE_AGE_MS) return false;
  return (
    quote.marketOpen &&
    (quote.marketClosesAt === null || now.getTime() < Date.parse(quote.marketClosesAt))
  );
}

type FillOutcome = "filled" | "cancelled" | "waiting";

async function fillOrder(order: CandidateRow, now: Date): Promise<FillOutcome> {
  const label = workingOrderLabel(order.order_type, order.side);
  // One key per order per minute: a rerun within the minute replays, and a
  // transient refusal never blocks the next minute's attempt.
  const minute = Math.floor(now.getTime() / 60_000);
  try {
    await placeOrder(
      {
        actorUserId: order.actor_user_id,
        symbol: order.symbol,
        side: order.side,
        quantity: Number(order.quantity),
        idempotencyKey: `working:${order.id}:${minute}`,
      },
      {
        systemTriggered: true,
        releaseWorkingOrderIds: [order.id],
        expectTeamId: order.team_id,
        activityLabel: label,
        beforeFill: async (tx) => {
          const current = await tx.get<{ status: string }>(
            "SELECT status FROM working_orders WHERE id = ?",
            [order.id],
          );
          if (current?.status !== "WORKING") {
            throw new AppError(
              "WORKING_ORDER_NOT_WAITING",
              "This order was already filled, cancelled, or expired.",
              409,
            );
          }
        },
        afterFill: async (tx, filled) => {
          const nowIso = new Date().toISOString();
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
    return "filled";
  } catch (error) {
    if (!(error instanceof AppError) || TRANSIENT_CODES.has(error.code)) {
      if (!(error instanceof AppError)) {
        console.error("Working order fill failed", order.id, error);
      }
      return "waiting";
    }
    const reason = cancellationReason(error);
    const db = await getDb();
    const cancelled = await db.transaction(async (tx) => {
      await lockTeam(tx, order.team_id);
      const ok = await closeOrder(tx, order.id, "CANCELLED", reason, new Date().toISOString());
      if (ok) {
        await logActivity(tx, order, "WORKING_ORDER_CANCELLED", reason, new Date().toISOString());
      }
      return ok;
    });
    return cancelled ? "cancelled" : "waiting";
  }
}

/**
 * One pass of the price checker. Safe to call as often as wanted and from
 * several places at once.
 */
export async function runWorkingOrders(at?: Date): Promise<WorkingOrderRunReport> {
  const now = at ?? marketDataNow();
  const nowIso = now.toISOString();
  const report: WorkingOrderRunReport = {
    checked: 0,
    filled: 0,
    cancelled: 0,
    expired: await expireDueOrders(nowIso),
    skippedSymbols: [],
  };

  const open = await readCandidates();
  // A disqualified team can never trade again, so its orders are cancelled
  // rather than left waiting. Frozen teams keep theirs: a host can unfreeze.
  for (const order of open.filter((o) => !o.sandbox_owner_user_id && o.team_status === "disqualified")) {
    const db = await getDb();
    const reason = "The team was disqualified.";
    const cancelled = await db.transaction(async (tx) => {
      await lockTeam(tx, order.team_id);
      const ok = await closeOrder(tx, order.id, "CANCELLED", reason, nowIso);
      if (ok && order.parent_id === null) {
        await logActivity(tx, order, "WORKING_ORDER_CANCELLED", reason, nowIso);
      }
      return ok;
    });
    if (cancelled) report.cancelled += 1;
  }
  const candidates = open.filter((order) => teamCanTrade(order, nowIso));
  report.checked = candidates.length;
  const bySymbol = new Map<string, CandidateRow[]>();
  for (const order of candidates) {
    bySymbol.set(order.symbol, [...(bySymbol.get(order.symbol) ?? []), order]);
  }

  for (const [symbol, orders] of bySymbol) {
    let quote: Quote | null = null;
    try {
      quote = await refreshQuote(symbol, now);
    } catch {
      quote = null;
    }
    if (!usableQuote(quote, now)) {
      report.skippedSymbols.push(symbol);
      continue;
    }
    for (const order of orders) {
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
      const outcome = await fillOrder(order, now);
      if (outcome === "filled") report.filled += 1;
      if (outcome === "cancelled") report.cancelled += 1;
    }
  }
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
