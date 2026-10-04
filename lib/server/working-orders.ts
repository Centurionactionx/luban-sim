import { randomUUID } from "node:crypto";

import type {
  PlaceWorkingOrderInput,
  TimeInForce,
  TradeSide,
  WorkingOrderStatus,
  WorkingOrderType,
  WorkingOrderView,
} from "../contracts";
import { AppError } from "../errors";
import { unitWord } from "../lots";
import { acquireAccountReadLock, type DbExecutor } from "./database";
import { getDb } from "./db";
import {
  MARKET_SYMBOL_PATTERN,
  isAssetClassEnabled,
  isSymbolBlocked,
  normalizeMarketSymbol,
  requireQuote,
} from "./quotes";
import {
  MAX_OPEN_WORKING_ORDERS_PER_TEAM,
  assertBracketPrices,
  assertWorkingOrderShape,
  countOpenWorkingOrders,
  insertBracketExits,
  insertWorkingOrder,
  optionalPriceCents,
  readReservations,
  workingOrderExpiresAt,
  workingOrdersAvailableTo,
} from "./working-order-book";

/**
 * Placing, cancelling, and listing orders that wait for a price. Nothing here
 * moves money: cash and shares are only set aside (by subtraction at check
 * time), and fills go through placeOrder like any market order.
 */

const MAX_QUANTITY = 100_000;
/** Waiting orders one person can place per rolling minute. */
const MAX_PLACEMENTS_PER_MINUTE = 30;
/**
 * USD listings set aside 2% extra CAD, so ordinary USD/CAD movement before the
 * fill doesn't leave a funded order short of cash.
 */
const USD_RESERVE_BUFFER = 1.02;
const ORDER_TYPES: readonly WorkingOrderType[] = ["LIMIT", "STOP_LOSS", "TAKE_PROFIT"];

interface AccountRow {
  user_id: string;
  actor_name: string;
  role: "student" | "host" | "platform_admin";
  user_status: string;
  team_id: string | null;
  sandbox_owner_user_id: string | null;
  team_status: string | null;
  cash_cents: number | null;
  competition_id: string | null;
  competition_status: string | null;
  competition_starts_at: string | null;
  competition_ends_at: string | null;
}

interface WorkingOrderRow {
  id: string;
  team_id: string;
  actor_user_id: string;
  actor_name: string | null;
  idempotency_key: string;
  symbol: string;
  side: TradeSide;
  order_type: WorkingOrderType;
  quantity: number;
  trigger_price_cents: number;
  listing_currency: "CAD" | "USD";
  reserved_cash_cents: number;
  time_in_force: TimeInForce;
  expires_at: string | null;
  status: WorkingOrderStatus;
  status_reason: string | null;
  parent_id: string | null;
  oco_group_id: string | null;
  filled_order_id: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_WORKING_ORDER = `
  SELECT
    w.id, w.team_id, w.actor_user_id, u.name AS actor_name, w.idempotency_key,
    w.symbol, w.side,
    w.order_type, w.quantity, w.trigger_price_cents, i.listing_currency,
    w.reserved_cash_cents, w.time_in_force, w.expires_at, w.status,
    w.status_reason, w.parent_id, w.oco_group_id, w.filled_order_id,
    w.created_at, w.updated_at
  FROM working_orders AS w
  LEFT JOIN users AS u ON u.id = w.actor_user_id
  JOIN instruments AS i ON i.symbol = w.symbol`;

function rowToView(row: WorkingOrderRow): WorkingOrderView {
  return {
    id: row.id,
    teamId: row.team_id,
    actorUserId: row.actor_user_id,
    actorName: row.actor_name ?? "Former member",
    symbol: row.symbol,
    side: row.side,
    orderType: row.order_type,
    quantity: Number(row.quantity),
    triggerPriceCents: Number(row.trigger_price_cents),
    listingCurrency: row.listing_currency,
    reservedCashCents: Number(row.reserved_cash_cents),
    timeInForce: row.time_in_force,
    expiresAt: row.expires_at,
    status: row.status,
    statusReason: row.status_reason,
    parentId: row.parent_id,
    ocoGroupId: row.oco_group_id,
    filledOrderId: row.filled_order_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function workingOrderLabel(orderType: WorkingOrderType, side: TradeSide): string {
  if (orderType === "STOP_LOSS") return "Stop loss";
  if (orderType === "TAKE_PROFIT") return "Take profit";
  return side === "BUY" ? "Limit buy" : "Limit sell";
}

function formatPrice(cents: number, currency: "CAD" | "USD"): string {
  return `${new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    currencyDisplay: "narrowSymbol",
  }).format(cents / 100)}${currency === "USD" ? " USD" : ""}`;
}

/** Serialize with fills and other order changes on the same team. */
async function lockTeam(tx: DbExecutor, teamId: string): Promise<void> {
  await acquireAccountReadLock(tx);
  if (tx.engine === "postgres") {
    await tx.all("SELECT id FROM teams WHERE id = ? FOR UPDATE", [teamId]);
  }
}

async function readAccount(tx: DbExecutor, userId: string): Promise<AccountRow> {
  const account = await tx.get<AccountRow>(
    `SELECT
       u.id AS user_id, u.name AS actor_name, u.role, u.status AS user_status,
       t.id AS team_id, t.sandbox_owner_user_id, t.status AS team_status, t.cash_cents,
       c.id AS competition_id, c.status AS competition_status,
       c.starts_at AS competition_starts_at, c.ends_at AS competition_ends_at
     FROM users u
     LEFT JOIN team_members tm ON tm.user_id = u.id AND u.role = 'student'
     LEFT JOIN teams t ON
       (u.role = 'student' AND t.id = tm.team_id)
       OR (u.role = 'platform_admin' AND t.sandbox_owner_user_id = u.id)
     LEFT JOIN competitions c ON c.id = t.competition_id
     WHERE u.id = ?`,
    [userId],
  );
  if (!account) throw new AppError("UNAUTHORIZED", "Sign in before placing an order.", 401);
  if (account.user_status !== "active") {
    throw new AppError("ACCOUNT_SUSPENDED", "This account is suspended.", 403);
  }
  if (account.role === "host") {
    throw new AppError("HOST_CANNOT_TRADE", "Host accounts cannot trade in a team portfolio.", 403);
  }
  if (!account.team_id || !account.competition_id || account.cash_cents === null) {
    throw new AppError(
      account.role === "platform_admin" ? "ADMIN_TRADING_ACCOUNT_REQUIRED" : "TEAM_REQUIRED",
      account.role === "platform_admin"
        ? "Set test-account cash before placing an admin sandbox order."
        : "Join a team before trading.",
      403,
    );
  }
  return account;
}

function assertWorkingOrdersAvailable(account: AccountRow): void {
  if (!workingOrdersAvailableTo(account.role)) {
    throw new AppError(
      "WORKING_ORDERS_DISABLED",
      "Limit, stop loss, and take profit orders aren't open in this competition yet.",
      409,
    );
  }
}

/**
 * Lock the person's team, then read the account again under the lock, so
 * cash and membership can't change between the read and the write.
 */
async function lockAccount(tx: DbExecutor, userId: string): Promise<AccountRow> {
  const first = await readAccount(tx, userId);
  await lockTeam(tx, first.team_id as string);
  const locked = await readAccount(tx, userId);
  if (locked.team_id !== first.team_id) {
    throw new AppError(
      "PORTFOLIO_CONFLICT",
      "The team changed while this request was being processed. Try again.",
      409,
    );
  }
  return locked;
}

/**
 * The same window market orders use: orders can be placed outside market
 * hours (that is the point), but not outside the competition or while the
 * team can't trade. The admin sandbox is exempt.
 */
function assertCanPlace(account: AccountRow, nowIso: string): void {
  if (account.role === "platform_admin") return;
  if (account.competition_status !== "active") {
    throw new AppError(
      "TRADING_CLOSED",
      account.competition_status === "paused"
        ? "Trading is temporarily paused by the host."
        : "This competition is not accepting trades.",
      409,
    );
  }
  if (account.competition_starts_at && nowIso < account.competition_starts_at) {
    throw new AppError("TRADING_CLOSED", "Trading has not opened yet for this competition.", 409);
  }
  if (account.competition_ends_at && nowIso >= account.competition_ends_at) {
    throw new AppError("TRADING_CLOSED", "This competition has ended.", 409);
  }
  if (account.team_status !== "active") {
    throw new AppError(
      "TEAM_NOT_ACTIVE",
      account.team_status === "frozen"
        ? "This team is frozen. Ask the host to restore trading."
        : "This team is disqualified and cannot trade.",
      409,
    );
  }
}

function normalizeInput(input: PlaceWorkingOrderInput) {
  const actorUserId = input.actorUserId?.trim();
  if (!actorUserId) throw new AppError("UNAUTHORIZED", "Sign in before placing an order.", 401);
  const symbol = input.symbol ? normalizeMarketSymbol(input.symbol) : "";
  if (!symbol || !MARKET_SYMBOL_PATTERN.test(symbol)) {
    throw new AppError("INVALID_SYMBOL", "Enter a valid market symbol.", 400);
  }
  const side = String(input.side ?? "").toUpperCase() as TradeSide;
  if (side !== "BUY" && side !== "SELL") {
    throw new AppError("INVALID_SIDE", "Order side must be BUY or SELL.", 400);
  }
  const orderType = String(input.orderType ?? "").toUpperCase() as WorkingOrderType;
  if (!ORDER_TYPES.includes(orderType)) {
    throw new AppError("INVALID_ORDER_TYPE", "Choose limit, stop loss, or take profit.", 400);
  }
  assertWorkingOrderShape(side, orderType);
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > MAX_QUANTITY) {
    throw new AppError(
      "INVALID_QUANTITY",
      `Quantity must be a whole number from 1 to ${MAX_QUANTITY.toLocaleString("en-CA")}.`,
      400,
    );
  }
  const triggerPriceCents = optionalPriceCents(input.triggerPriceCents, "price");
  if (triggerPriceCents === null) {
    throw new AppError("INVALID_PRICE", "Enter the price for this order.", 400, { field: "price" });
  }
  if (input.timeInForce !== "DAY" && input.timeInForce !== "GTC") {
    throw new AppError("INVALID_TIME_IN_FORCE", "Choose Day or Good until cancelled.", 400);
  }
  const idempotencyKey = input.idempotencyKey?.trim();
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    throw new AppError(
      "INVALID_IDEMPOTENCY_KEY",
      "An idempotency key between 8 and 128 characters is required.",
      400,
    );
  }
  const takeProfitCents = optionalPriceCents(input.bracket?.takeProfitCents, "take profit");
  const stopLossCents = optionalPriceCents(input.bracket?.stopLossCents, "stop loss");
  const hasBracket = takeProfitCents !== null || stopLossCents !== null;
  if (hasBracket && !(orderType === "LIMIT" && side === "BUY")) {
    throw new AppError(
      "INVALID_BRACKET",
      "Take profit and stop loss exits can only be attached to a buy.",
      400,
    );
  }
  return {
    actorUserId,
    symbol,
    side,
    orderType,
    quantity: input.quantity,
    triggerPriceCents,
    timeInForce: input.timeInForce,
    idempotencyKey,
    bracket: hasBracket ? { takeProfitCents, stopLossCents } : null,
  };
}

/**
 * Place a limit, stop-loss, or take-profit order. A limit buy may carry a
 * bracket; its exits wait (PENDING_PARENT) until the buy fills. Repeating a
 * request with the same idempotency key returns the original order.
 */
export async function placeWorkingOrder(
  input: PlaceWorkingOrderInput,
): Promise<WorkingOrderView[]> {
  const order = normalizeInput(input);
  const quote = await requireQuote(order.symbol);

  if (order.orderType === "STOP_LOSS" && order.triggerPriceCents >= quote.priceCents) {
    throw new AppError(
      "INVALID_PRICE",
      "A stop loss must be below the current price, or it would sell right away.",
      400,
      { field: "price" },
    );
  }
  if (order.orderType === "TAKE_PROFIT" && order.triggerPriceCents <= quote.priceCents) {
    throw new AppError(
      "INVALID_PRICE",
      "A take profit must be above the current price, or it would sell right away.",
      400,
      { field: "price" },
    );
  }
  if (order.bracket) {
    assertBracketPrices(order.triggerPriceCents, order.bracket, "limit price");
  }
  if (quote.tradingHaltReason) {
    throw new AppError("TRADING_HALTED", quote.tradingHaltReason, 409, { symbol: order.symbol });
  }
  if (order.side === "BUY") {
    if (!isAssetClassEnabled(quote.assetClass)) {
      throw new AppError(
        "ASSET_CLASS_DISABLED",
        `${quote.assetClass === "CRYPTO" ? "Crypto" : "ETF"} trading is not open in this competition.`,
        409,
      );
    }
    if (isSymbolBlocked(order.symbol)) {
      throw new AppError(
        "SYMBOL_BLOCKED",
        `${order.symbol} has been removed from the simulator.`,
        409,
      );
    }
    if (quote.assetClass === "CRYPTO" && quote.priceCadCents < 100) {
      throw new AppError(
        "LOT_TOO_SMALL",
        `One lot of ${order.symbol} is worth less than $1, so new buys are paused.`,
        409,
      );
    }
  }
  // What a limit buy sets aside: its cost at the limit, priced per share the
  // way a fill is (rounded CAD per share, times quantity), with a buffer for
  // exchange-rate movement on USD listings.
  const fxBasisPoints =
    quote.listingCurrency === "USD"
      ? quote.fxRateBasisPoints * USD_RESERVE_BUFFER
      : quote.fxRateBasisPoints;
  const reservedCashCents =
    order.side === "BUY"
      ? Math.ceil((order.triggerPriceCents * fxBasisPoints) / 10_000) * order.quantity
      : 0;
  if (!Number.isSafeInteger(reservedCashCents)) {
    throw new AppError("ORDER_TOO_LARGE", "This order is too large for the simulator.", 400);
  }

  const db = await getDb();
  return db.transaction(async (tx) => {
    const account = await lockAccount(tx, order.actorUserId);
    const teamId = account.team_id as string;

    // A repeated request returns what the first one created.
    const entry = await tx.get<WorkingOrderRow>(
      `${SELECT_WORKING_ORDER} WHERE w.actor_user_id = ? AND w.idempotency_key = ?`,
      [order.actorUserId, order.idempotencyKey],
    );
    if (entry) {
      if (
        entry.symbol !== order.symbol ||
        entry.side !== order.side ||
        entry.order_type !== order.orderType ||
        Number(entry.quantity) !== order.quantity ||
        Number(entry.trigger_price_cents) !== order.triggerPriceCents ||
        entry.time_in_force !== order.timeInForce
      ) {
        throw new AppError(
          "IDEMPOTENCY_CONFLICT",
          "That idempotency key was already used for a different order.",
          409,
        );
      }
      const legs = await tx.all<WorkingOrderRow>(
        `${SELECT_WORKING_ORDER} WHERE w.parent_id = ? ORDER BY w.order_type ASC`,
        [entry.id],
      );
      return [entry, ...legs].map(rowToView);
    }

    assertWorkingOrdersAvailable(account);
    const nowIso = new Date().toISOString();
    assertCanPlace(account, nowIso);

    const recent = await tx.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM working_orders
       WHERE actor_user_id = ? AND parent_id IS NULL AND created_at > ?`,
      [order.actorUserId, new Date(Date.now() - 60_000).toISOString()],
    );
    if (Number(recent?.count ?? 0) >= MAX_PLACEMENTS_PER_MINUTE) {
      throw new AppError(
        "ORDER_RATE_LIMITED",
        `Slow down: at most ${MAX_PLACEMENTS_PER_MINUTE} waiting orders per minute. Try again shortly.`,
        429,
      );
    }

    const open = await countOpenWorkingOrders(tx, teamId);
    const newOrders = 1 + (order.bracket?.takeProfitCents ? 1 : 0) + (order.bracket?.stopLossCents ? 1 : 0);
    if (open + newOrders > MAX_OPEN_WORKING_ORDERS_PER_TEAM) {
      throw new AppError(
        "TOO_MANY_WORKING_ORDERS",
        `A team can have at most ${MAX_OPEN_WORKING_ORDERS_PER_TEAM} waiting orders. Cancel one first.`,
        409,
      );
    }

    const reservations = await readReservations(tx, teamId);
    if (order.side === "BUY") {
      const spendable = Number(account.cash_cents) - reservations.cashCents;
      if (reservedCashCents > spendable) {
        throw new AppError(
          "INSUFFICIENT_CASH",
          reservations.cashCents > 0
            ? "Not enough cash for this order at its limit price, after cash already set aside for waiting orders."
            : "Not enough cash for this order at its limit price.",
          409,
          { availableCents: spendable, requiredCents: reservedCashCents },
        );
      }
    } else {
      const holding = await tx.get<{ quantity: number }>(
        "SELECT quantity FROM holdings WHERE team_id = ? AND symbol = ?",
        [teamId, order.symbol],
      );
      const held = Number(holding?.quantity ?? 0);
      const sellable = held - (reservations.sharesBySymbol.get(order.symbol) ?? 0);
      if (order.quantity > sellable) {
        throw new AppError(
          "INSUFFICIENT_SHARES",
          sellable < held
            ? `Only ${Math.max(0, sellable)} ${unitWord(quote.assetClass, sellable)} of ${order.symbol} can be sold; the rest are held for other waiting sell orders.`
            : `The ${account.role === "platform_admin" ? "test account" : "team"} only owns ${held} ${unitWord(quote.assetClass, held)} of ${order.symbol}.`,
          409,
          { availableShares: Math.max(0, sellable), requestedShares: order.quantity },
        );
      }
    }

    const expiresAt = workingOrderExpiresAt(order.timeInForce, quote.assetClass, new Date(nowIso));
    const entryId = await insertWorkingOrder(tx, {
      teamId,
      actorUserId: order.actorUserId,
      idempotencyKey: order.idempotencyKey,
      symbol: order.symbol,
      side: order.side,
      orderType: order.orderType,
      quantity: order.quantity,
      triggerPriceCents: order.triggerPriceCents,
      reservedCashCents,
      timeInForce: order.timeInForce,
      expiresAt,
      status: "WORKING",
      parentId: null,
      ocoGroupId: null,
      now: nowIso,
    });
    if (order.bracket) {
      await insertBracketExits(tx, {
        teamId,
        actorUserId: order.actorUserId,
        idempotencyKey: order.idempotencyKey,
        symbol: order.symbol,
        quantity: order.quantity,
        takeProfitCents: order.bracket.takeProfitCents,
        stopLossCents: order.bracket.stopLossCents,
        timeInForce: order.timeInForce,
        expiresAt,
        status: "PENDING_PARENT",
        parentId: entryId,
        now: nowIso,
      });
    }

    const label = workingOrderLabel(order.orderType, order.side);
    const exits = [
      order.bracket?.takeProfitCents
        ? `take profit ${formatPrice(order.bracket.takeProfitCents, quote.listingCurrency)}`
        : null,
      order.bracket?.stopLossCents
        ? `stop loss ${formatPrice(order.bracket.stopLossCents, quote.listingCurrency)}`
        : null,
    ].filter(Boolean);
    await tx.run(
      `INSERT INTO activity_events (
         id, competition_id, team_id, actor_user_id, type, title, detail, created_at
       ) VALUES (?, ?, ?, ?, 'WORKING_ORDER_PLACED', ?, ?, ?)`,
      [
        randomUUID(),
        account.competition_id,
        teamId,
        order.actorUserId,
        `${label} ${order.symbol}`,
        `${account.actor_name} placed a ${label.toLowerCase()} for ${order.quantity} ${unitWord(quote.assetClass, order.quantity)} of ${order.symbol} at ${formatPrice(order.triggerPriceCents, quote.listingCurrency)}${exits.length ? ` (${exits.join(", ")})` : ""}.`,
        nowIso,
      ],
    );

    const created = await tx.all<WorkingOrderRow>(
      `${SELECT_WORKING_ORDER}
       WHERE w.id = ? OR w.parent_id = ?
       ORDER BY w.created_at ASC, w.order_type ASC`,
      [entryId, entryId],
    );
    return created.map(rowToView);
  });
}

/**
 * Cancel a waiting order. Any teammate can cancel the team's orders (it is
 * one shared portfolio). Cancelling a buy also cancels its bracket exits that
 * were still waiting for it.
 */
export async function cancelWorkingOrder(input: {
  actorUserId: string;
  workingOrderId: string;
}): Promise<WorkingOrderView> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    // Cancelling always works, even with the feature switched off, so set-aside
    // cash and shares can always be freed.
    const account = await lockAccount(tx, input.actorUserId);
    const teamId = account.team_id as string;

    const row = await tx.get<WorkingOrderRow>(`${SELECT_WORKING_ORDER} WHERE w.id = ?`, [
      input.workingOrderId,
    ]);
    if (!row || row.team_id !== teamId) {
      throw new AppError("WORKING_ORDER_NOT_FOUND", "That order isn't one of your team's.", 404);
    }
    if (row.status !== "WORKING" && row.status !== "PENDING_PARENT") {
      throw new AppError(
        "WORKING_ORDER_CLOSED",
        `That order is already ${row.status.toLowerCase()}.`,
        409,
      );
    }

    const nowIso = new Date().toISOString();
    const reason = `Cancelled by ${account.actor_name}.`;
    await tx.run(
      `UPDATE working_orders
       SET status = 'CANCELLED', status_reason = ?, updated_at = ?
       WHERE id = ? AND status IN ('WORKING', 'PENDING_PARENT')`,
      [reason, nowIso, row.id],
    );
    await tx.run(
      `UPDATE working_orders
       SET status = 'CANCELLED', status_reason = ?, updated_at = ?
       WHERE parent_id = ? AND status = 'PENDING_PARENT'`,
      ["Cancelled with the buy it was attached to.", nowIso, row.id],
    );

    const label = workingOrderLabel(row.order_type, row.side);
    await tx.run(
      `INSERT INTO activity_events (
         id, competition_id, team_id, actor_user_id, type, title, detail, created_at
       ) VALUES (?, ?, ?, ?, 'WORKING_ORDER_CANCELLED', ?, ?, ?)`,
      [
        randomUUID(),
        account.competition_id,
        teamId,
        input.actorUserId,
        `${label} ${row.symbol} cancelled`,
        `${account.actor_name} cancelled a ${label.toLowerCase()} for ${Number(row.quantity)} of ${row.symbol} at ${formatPrice(Number(row.trigger_price_cents), row.listing_currency)}.`,
        nowIso,
      ],
    );

    const updated = await tx.get<WorkingOrderRow>(`${SELECT_WORKING_ORDER} WHERE w.id = ?`, [
      row.id,
    ]);
    return rowToView(updated as WorkingOrderRow);
  });
}

/** A team's waiting orders, newest first; closed ones only when asked. */
export async function listWorkingOrders(
  teamId: string,
  options: { includeClosed?: boolean; limit?: number } = {},
): Promise<WorkingOrderView[]> {
  const db = await getDb();
  const rows = await db.all<WorkingOrderRow>(
    `${SELECT_WORKING_ORDER}
     WHERE w.team_id = ?
       ${options.includeClosed ? "" : "AND w.status IN ('WORKING', 'PENDING_PARENT')"}
     ORDER BY w.created_at DESC, w.order_type ASC
     LIMIT ?`,
    [teamId, options.limit ?? 50],
  );
  return rows.map(rowToView);
}

/** Cash and shares a team has set aside for waiting orders (for display). */
export async function getTeamReservations(teamId: string) {
  return readReservations(await getDb(), teamId);
}
