import { randomUUID } from "node:crypto";

import type {
  AssetClass,
  TimeInForce,
  TradeSide,
  WorkingOrderStatus,
  WorkingOrderType,
} from "../contracts";
import { AppError } from "../errors";
import { isoToZonedInputValue, zonedInputValueToIso } from "../time";
import type { DbExecutor } from "./database";

/**
 * Shared, side-effect-free rules and storage helpers for waiting orders. Both
 * the fill code (trading.ts) and the working-order service use them, so they
 * live apart from either to avoid a circular import.
 */

/**
 * Waiting orders and brackets are on for everyone when
 * LUBAN_ENABLE_WORKING_ORDERS=true. Platform admins can always use them in
 * their private test account, so they can be tried on live prices first.
 */
export function workingOrdersAvailableTo(role: string): boolean {
  return (
    role === "platform_admin" ||
    process.env.LUBAN_ENABLE_WORKING_ORDERS?.trim().toLowerCase() === "true"
  );
}

/** Most orders a team can have waiting at once. */
export const MAX_OPEN_WORKING_ORDERS_PER_TEAM = 20;

const OPEN_STATUSES: readonly WorkingOrderStatus[] = ["PENDING_PARENT", "WORKING"];

/** Which order types make sense on which side. */
export function assertWorkingOrderShape(side: TradeSide, orderType: WorkingOrderType): void {
  if (orderType !== "LIMIT" && side !== "SELL") {
    throw new AppError(
      "INVALID_ORDER_TYPE",
      orderType === "STOP_LOSS"
        ? "A stop loss sells shares you hold, so it must be a sell order."
        : "A take profit sells shares you hold, so it must be a sell order.",
      400,
    );
  }
}

/**
 * Whether a waiting order's price condition is met by the latest price (per
 * share, or per lot for crypto, in the listing's currency).
 *
 * - Limit buy: price at or below the limit.
 * - Limit sell / take profit: price at or above the target.
 * - Stop loss: price at or below the stop.
 */
export function workingOrderTriggered(
  order: { side: TradeSide; orderType: WorkingOrderType; triggerPriceCents: number },
  priceCents: number,
): boolean {
  if (order.orderType === "STOP_LOSS") return priceCents <= order.triggerPriceCents;
  if (order.orderType === "TAKE_PROFIT") return priceCents >= order.triggerPriceCents;
  return order.side === "BUY"
    ? priceCents <= order.triggerPriceCents
    : priceCents >= order.triggerPriceCents;
}

function torontoDateParts(at: Date): { date: string; minutes: number; weekday: number } {
  const value = isoToZonedInputValue(at.toISOString());
  const [date, time] = value.split("T");
  const [hour, minute] = time.split(":").map(Number);
  const [year, month, day] = date.split("-").map(Number);
  return {
    date,
    minutes: hour * 60 + minute,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

function nextCalendarDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

/**
 * Full-day closures. CAD listings follow the TSX calendar, USD listings the
 * NYSE/Nasdaq one. Early (1 p.m.) closes are not modelled. Extend the lists
 * each year; a missing year falls back to weekdays only.
 */
const MARKET_HOLIDAYS: Record<"CAD" | "USD", ReadonlySet<string>> = {
  CAD: new Set([
    "2026-01-01", "2026-02-16", "2026-04-03", "2026-05-18", "2026-07-01",
    "2026-08-03", "2026-09-07", "2026-10-12", "2026-12-25", "2026-12-28",
    "2027-01-01", "2027-02-15", "2027-03-26", "2027-05-24", "2027-07-01",
    "2027-08-02", "2027-09-06", "2027-10-11", "2027-12-27", "2027-12-28",
  ]),
  USD: new Set([
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
    "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
    "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
    "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
  ]),
};

function isTradingDay(
  date: string,
  weekday: number,
  listingCurrency: "CAD" | "USD" | undefined,
): boolean {
  if (weekday === 0 || weekday === 6) return false;
  return !listingCurrency || !MARKET_HOLIDAYS[listingCurrency].has(date);
}

/**
 * When a DAY order stops working. Stocks and ETFs: the next 4:00 p.m.
 * Eastern close on a trading day of the listing's market (today's, if placed
 * before it), so an order placed before a holiday still gets a session.
 * Crypto trades around the clock, so its "day" is the Eastern calendar day.
 * GTC orders have no clock expiry; they end with the competition.
 */
export function workingOrderExpiresAt(
  timeInForce: TimeInForce,
  assetClass: AssetClass | undefined,
  at: Date,
  listingCurrency?: "CAD" | "USD",
): string | null {
  if (timeInForce === "GTC") return null;
  const now = torontoDateParts(at);

  if (assetClass === "CRYPTO") {
    return zonedInputValueToIso(`${nextCalendarDate(now.date)}T00:00`);
  }

  let date = now.date;
  let weekday = now.weekday;
  const closeMinutes = 16 * 60;
  if (!isTradingDay(date, weekday, listingCurrency) || now.minutes >= closeMinutes) {
    do {
      date = nextCalendarDate(date);
      weekday = (weekday + 1) % 7;
    } while (!isTradingDay(date, weekday, listingCurrency));
  }
  return zonedInputValueToIso(`${date}T16:00`);
}

/**
 * Whether North American stock and ETF markets could be open: weekdays,
 * 9:25 a.m. to 4:05 p.m. Eastern (a few minutes either side of the session).
 * Lets the price checker skip fetching stock quotes at night and on weekends;
 * the quote's own session data still decides whether a fill happens.
 */
export function stockSessionMayBeOpen(at: Date): boolean {
  const now = torontoDateParts(at);
  if (now.weekday === 0 || now.weekday === 6) return false;
  return now.minutes >= 9 * 60 + 25 && now.minutes <= 16 * 60 + 5;
}

export interface Reservations {
  /** CAD cents set aside for waiting buys. */
  cashCents: number;
  /** Shares (lots) set aside for waiting sells, by symbol. */
  sharesBySymbol: Map<string, number>;
}

/**
 * Cash and shares a team has set aside for its waiting orders.
 *
 * Buys set aside the cash they would cost at their limit. Sells set aside
 * the shares they would sell; a bracket's take profit and stop loss cover the
 * same shares, so a group counts once (its largest leg). Orders in
 * `excluding`, and any bracket group one of them belongs to, are left out:
 * that is how a fill uses the very reservation it was holding.
 */
export async function readReservations(
  executor: DbExecutor,
  teamId: string,
  excluding: readonly string[] = [],
): Promise<Reservations> {
  const rows = await executor.all<{
    id: string;
    side: TradeSide;
    symbol: string;
    quantity: number;
    reserved_cash_cents: number;
    oco_group_id: string | null;
  }>(
    `SELECT id, side, symbol, quantity, reserved_cash_cents, oco_group_id
     FROM working_orders
     WHERE team_id = ? AND status = 'WORKING'`,
    [teamId],
  );

  const excluded = new Set(excluding);
  const excludedGroups = new Set(
    rows
      .filter((row) => excluded.has(row.id) && row.oco_group_id)
      .map((row) => row.oco_group_id as string),
  );

  let cashCents = 0;
  const largestByGroup = new Map<string, { symbol: string; quantity: number }>();
  for (const row of rows) {
    if (excluded.has(row.id)) continue;
    if (row.oco_group_id && excludedGroups.has(row.oco_group_id)) continue;
    if (row.side === "BUY") {
      cashCents += Number(row.reserved_cash_cents);
      continue;
    }
    const group = row.oco_group_id ?? row.id;
    const quantity = Number(row.quantity);
    const current = largestByGroup.get(group);
    if (!current || quantity > current.quantity) {
      largestByGroup.set(group, { symbol: row.symbol, quantity });
    }
  }

  const sharesBySymbol = new Map<string, number>();
  for (const { symbol, quantity } of largestByGroup.values()) {
    sharesBySymbol.set(symbol, (sharesBySymbol.get(symbol) ?? 0) + quantity);
  }
  return { cashCents, sharesBySymbol };
}

export async function countOpenWorkingOrders(
  executor: DbExecutor,
  teamId: string,
): Promise<number> {
  const row = await executor.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM working_orders
     WHERE team_id = ? AND status IN (${OPEN_STATUSES.map(() => "?").join(", ")})`,
    [teamId, ...OPEN_STATUSES],
  );
  return Number(row?.count ?? 0);
}

export interface NewWorkingOrder {
  teamId: string;
  actorUserId: string;
  idempotencyKey: string;
  symbol: string;
  side: TradeSide;
  orderType: WorkingOrderType;
  quantity: number;
  triggerPriceCents: number;
  reservedCashCents: number;
  timeInForce: TimeInForce;
  expiresAt: string | null;
  status: "PENDING_PARENT" | "WORKING";
  parentId: string | null;
  ocoGroupId: string | null;
  now: string;
}

export async function insertWorkingOrder(
  executor: DbExecutor,
  order: NewWorkingOrder,
): Promise<string> {
  const id = randomUUID();
  await executor.run(
    `INSERT INTO working_orders (
       id, team_id, actor_user_id, idempotency_key, symbol, side, order_type,
       quantity, trigger_price_cents, reserved_cash_cents, time_in_force,
       expires_at, status, status_reason, parent_id, oco_group_id,
       filled_order_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?)`,
    [
      id,
      order.teamId,
      order.actorUserId,
      order.idempotencyKey,
      order.symbol,
      order.side,
      order.orderType,
      order.quantity,
      order.triggerPriceCents,
      order.reservedCashCents,
      order.timeInForce,
      order.expiresAt,
      order.status,
      order.parentId,
      order.ocoGroupId,
      order.now,
      order.now,
    ],
  );
  return id;
}

/**
 * The exits of a bracket: a take-profit limit sell and/or a stop-loss sell
 * for the bought quantity. With both, they share a group so that when one
 * fills the other is cancelled. Returns the ids created.
 */
export async function insertBracketExits(
  executor: DbExecutor,
  input: {
    teamId: string;
    actorUserId: string;
    idempotencyKey: string;
    symbol: string;
    quantity: number;
    takeProfitCents: number | null;
    stopLossCents: number | null;
    timeInForce: TimeInForce;
    expiresAt: string | null;
    status: "PENDING_PARENT" | "WORKING";
    parentId: string | null;
    now: string;
  },
): Promise<string[]> {
  const legs: Array<{ type: WorkingOrderType; price: number }> = [];
  if (input.takeProfitCents) legs.push({ type: "TAKE_PROFIT", price: input.takeProfitCents });
  if (input.stopLossCents) legs.push({ type: "STOP_LOSS", price: input.stopLossCents });
  const ocoGroupId = legs.length > 1 ? randomUUID() : null;

  const ids: string[] = [];
  for (const leg of legs) {
    ids.push(
      await insertWorkingOrder(executor, {
        teamId: input.teamId,
        actorUserId: input.actorUserId,
        idempotencyKey: `${input.idempotencyKey}:${leg.type.toLowerCase()}`,
        symbol: input.symbol,
        side: "SELL",
        orderType: leg.type,
        quantity: input.quantity,
        triggerPriceCents: leg.price,
        reservedCashCents: 0,
        timeInForce: input.timeInForce,
        expiresAt: input.expiresAt,
        status: input.status,
        parentId: input.parentId,
        ocoGroupId,
        now: input.now,
      }),
    );
  }
  return ids;
}

/**
 * Bracket prices must sit on the right side of the entry: a take profit
 * above it and a stop loss below it. Prices are per share (per lot) in the
 * listing's currency, like the entry.
 */
export function assertBracketPrices(
  entryPriceCents: number,
  bracket: { takeProfitCents: number | null; stopLossCents: number | null },
  entryLabel: string,
): void {
  if (bracket.takeProfitCents !== null && bracket.takeProfitCents <= entryPriceCents) {
    throw new AppError(
      "INVALID_BRACKET",
      `The take profit must be above the ${entryLabel}.`,
      400,
      { field: "takeProfit" },
    );
  }
  if (bracket.stopLossCents !== null && bracket.stopLossCents >= entryPriceCents) {
    throw new AppError(
      "INVALID_BRACKET",
      `The stop loss must be below the ${entryLabel}.`,
      400,
      { field: "stopLoss" },
    );
  }
}

/** The highest price an order can name: $100 million per share or lot. */
export const MAX_ORDER_PRICE_CENTS = 10_000_000_000;

/** A positive whole number of cents, or null for "not set". */
export function optionalPriceCents(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > MAX_ORDER_PRICE_CENTS
  ) {
    throw new AppError(
      "INVALID_PRICE",
      `The ${field} must be a positive price.`,
      400,
      { field },
    );
  }
  return value as number;
}
