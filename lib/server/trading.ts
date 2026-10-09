import { randomUUID } from "node:crypto";

import type {
  BracketInput,
  CompetitionStatus,
  Quote,
  OrderView,
  PlaceOrderInput,
  SerializedAppError,
  TeamStatus,
  TradeReceipt,
  TradeSide,
} from "../contracts";
import { AppError } from "../errors";
import { acquireAccountReadLock, type DbExecutor } from "./database";
import { cryptoTokenSymbol, formatTokenQuantity, unitWord } from "../lots";
import { assertTeamLedgerReconciles, getDb } from "./db";
import { workingOrderExpiresAt } from "../market-calendar";
import { MAX_OPEN_WORKING_ORDERS_PER_TEAM, MAX_ORDER_QUANTITY } from "../order-math";
import {
  assertBracketPrices,
  countOpenWorkingOrders,
  insertBracketExits,
  optionalPriceCents,
  readReservations,
  workingOrdersAvailableTo,
} from "./working-order-book";
import {
  assertBuyAllowed,
  MARKET_SYMBOL_PATTERN,
  marketDataNow,
  normalizeMarketSymbol,
  requireQuote,
} from "./quotes";

const DEFAULT_MAX_ORDERS_PER_MINUTE = 20;
const ORDER_RATE_WINDOW_MS = 60_000;
const DEFAULT_MAX_QUOTE_AGE_MINUTES = 20;

/**
 * Oldest quote an order may fill against. Free TSX data runs about fifteen
 * minutes behind, so the default leaves a small margin above that delay
 * while refusing fills at prices from a previous session or a dead feed.
 */
export function maxQuoteAgeMs(): number {
  const raw = Number(process.env.LUBAN_MAX_QUOTE_AGE_MINUTES);

  if (Number.isSafeInteger(raw) && raw >= 1 && raw <= 1_440) {
    return raw * 60_000;
  }

  return DEFAULT_MAX_QUOTE_AGE_MINUTES * 60_000;
}

/**
 * Anti-spam ceiling on order attempts per student per rolling minute. The
 * default supports active day trading (an order every three seconds,
 * sustained) while stopping runaway scripts and button-mashing. Counted from
 * durable idempotency records inside the write transaction, so it holds
 * across processes and server restarts; genuine idempotent replays are
 * answered before the check and are never throttled.
 */
function maxOrdersPerMinute(): number {
  const raw = Number(process.env.LUBAN_MAX_ORDERS_PER_MINUTE);

  if (Number.isSafeInteger(raw) && raw >= 1 && raw <= 10_000) {
    return raw;
  }

  return DEFAULT_MAX_ORDERS_PER_MINUTE;
}

interface IdempotencyRecordRow {
  request_fingerprint: string;
  outcome_type: "FILLED" | "REJECTED";
  result_json: string | null;
  error_json: string | null;
}

interface TradingAccountRow {
  user_id: string;
  actor_name: string;
  role: "student" | "host" | "platform_admin";
  user_status: string;
  team_id: string | null;
  sandbox_owner_user_id: string | null;
  team_name: string | null;
  team_status: TeamStatus | null;
  cash_cents: number | null;
  version: number | null;
  competition_id: string | null;
  competition_status: CompetitionStatus | null;
  competition_starts_at: string | null;
  competition_ends_at: string | null;
}

interface HoldingRow {
  quantity: number;
  average_cost_cents: number;
}

interface NormalizedBracket {
  takeProfitCents: number | null;
  stopLossCents: number | null;
  timeInForce: "DAY" | "GTC";
}

interface NormalizedOrderInput {
  actorUserId: string;
  symbol: string;
  side: TradeSide;
  quantity: number;
  idempotencyKey: string;
  fingerprint: string;
  bracket: NormalizedBracket | null;
}

function normalizeOrderInput(
  input: PlaceOrderInput,
  systemTriggered = false,
): NormalizedOrderInput {
  const actorUserId = input.actorUserId?.trim();
  const symbol = input.symbol ? normalizeMarketSymbol(input.symbol) : "";
  const side = String(input.side ?? "").toUpperCase();
  const idempotencyKey = input.idempotencyKey?.trim();

  if (!actorUserId) {
    throw new AppError("UNAUTHORIZED", "Sign in before placing an order.", 401);
  }
  // "working:" keys mark fills the system makes for waiting orders (they
  // skip the per-minute allowance), so traders can't use that prefix.
  if (!systemTriggered && idempotencyKey && /^(working|bracket):/i.test(idempotencyKey)) {
    throw new AppError(
      "INVALID_IDEMPOTENCY_KEY",
      "That idempotency key format is reserved.",
      400,
    );
  }
  if (!symbol || !MARKET_SYMBOL_PATTERN.test(symbol)) {
    throw new AppError("INVALID_SYMBOL", "Enter a valid market symbol.", 400);
  }
  if (side !== "BUY" && side !== "SELL") {
    throw new AppError("INVALID_SIDE", "Order side must be BUY or SELL.", 400);
  }
  if (
    !Number.isSafeInteger(input.quantity) ||
    input.quantity < 1 ||
    input.quantity > MAX_ORDER_QUANTITY
  ) {
    throw new AppError(
      "INVALID_QUANTITY",
      `Quantity must be a whole number from 1 to ${MAX_ORDER_QUANTITY.toLocaleString("en-CA")}.`,
      400,
    );
  }
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    throw new AppError(
      "INVALID_IDEMPOTENCY_KEY",
      "An idempotency key between 8 and 128 characters is required.",
      400,
    );
  }

  const normalizedSide: TradeSide = side;
  const bracket = normalizeBracket(input.bracket, normalizedSide);
  return {
    actorUserId,
    symbol,
    side: normalizedSide,
    quantity: input.quantity,
    idempotencyKey,
    fingerprint:
      `${actorUserId}|${symbol}|${normalizedSide}|${input.quantity}` +
      (bracket
        ? `|tp:${bracket.takeProfitCents ?? "-"}|sl:${bracket.stopLossCents ?? "-"}|${bracket.timeInForce}`
        : ""),
    bracket,
  };
}

/** A bracket with at least one exit set, or null. Only buys can carry one. */
function normalizeBracket(
  bracket: BracketInput | undefined,
  side: TradeSide,
): NormalizedBracket | null {
  if (!bracket) return null;
  const takeProfitCents = optionalPriceCents(bracket.takeProfitCents, "take profit");
  const stopLossCents = optionalPriceCents(bracket.stopLossCents, "stop loss");
  if (takeProfitCents === null && stopLossCents === null) return null;
  if (side !== "BUY") {
    throw new AppError(
      "INVALID_BRACKET",
      "Take profit and stop loss exits can only be attached to a buy.",
      400,
    );
  }
  const timeInForce = bracket.timeInForce ?? "GTC";
  if (timeInForce !== "DAY" && timeInForce !== "GTC") {
    throw new AppError("INVALID_TIME_IN_FORCE", "Choose Day or Good until cancelled.", 400);
  }
  return { takeProfitCents, stopLossCents, timeInForce };
}

/**
 * Internal options for fills that are not a plain market order from the
 * order form. Never exposed through the API.
 */
export interface FillOptions {
  /**
   * Waiting orders this fill carries out. Their own set-aside cash and
   * shares (and their bracket partner's) are released for it.
   */
  releaseWorkingOrderIds?: readonly string[];
  /** System-triggered fills don't count toward the per-minute order limit. */
  systemTriggered?: boolean;
  /**
   * Fill against exactly this quote (the one the waiting order was checked
   * on), not whatever the cache holds a moment later. The usual stale,
   * halted, and market-hours checks still apply to it.
   */
  fillQuote?: Quote;
  /** The clock the fill quote was taken on, so freshness is judged on it. */
  now?: Date;
  /**
   * A limit or take profit must never fill on the wrong side of its price.
   * Checked on the fill quote before the transaction, so a refusal stores
   * nothing and the order simply waits for the next check.
   */
  priceLimit?: { side: TradeSide; limitCents: number };
  /** The fill must land in this team's portfolio, or it is refused. */
  expectTeamId?: string;
  /**
   * Runs inside the fill's transaction, under the team lock and before any
   * money moves. Throwing here refuses the fill with nothing written; the
   * working-order engine uses it to confirm the order is still waiting, which
   * makes triggered fills exactly-once even when two checkers race.
   */
  beforeFill?: (tx: DbExecutor) => Promise<void>;
  /**
   * Labels the activity entry, e.g. "Stop loss" turns "SELL SHOP.TO" into
   * "Stop loss: SELL SHOP.TO" and says it was triggered.
   */
  activityLabel?: string;
  /** Runs inside the fill's transaction, after the order is recorded. */
  afterFill?: (
    tx: DbExecutor,
    filled: { orderId: string; teamId: string; competitionId: string; actorName: string },
  ) => Promise<void>;
}

function parseStoredReceipt(value: string | null): TradeReceipt {
  if (value) {
    try {
      const receipt = JSON.parse(value) as TradeReceipt;
      return { ...receipt, duplicate: true };
    } catch {
      // Fall through to the invariant error below.
    }
  }
  throw new AppError(
    "IDEMPOTENCY_STATE_INVALID",
    "The saved order result could not be read.",
    500,
  );
}

function parseStoredError(value: string | null): AppError {
  if (value) {
    try {
      const error = JSON.parse(value) as SerializedAppError;
      return new AppError(error.code, error.message, error.status, error.details);
    } catch {
      // Fall through to the invariant error below.
    }
  }
  return new AppError(
    "IDEMPOTENCY_STATE_INVALID",
    "The saved order rejection could not be read.",
    500,
  );
}

function shouldPersistRejection(error: unknown): error is AppError {
  return (
    error instanceof AppError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.code !== "UNAUTHORIZED" &&
    error.code !== "IDEMPOTENCY_CONFLICT" &&
    error.code !== "PORTFOLIO_CONFLICT" &&
    // A throttled attempt must stay retryable: persisting it would replay
    // the 429 forever for that idempotency key.
    error.code !== "ORDER_RATE_LIMITED" &&
    // A run that lost a race for a waiting order: nothing to remember.
    error.code !== "WORKING_ORDER_NOT_WAITING"
  );
}

function replayOutcome(
  existing: IdempotencyRecordRow,
  fingerprint: string,
): { receipt?: TradeReceipt; error?: AppError } {
  if (existing.request_fingerprint !== fingerprint) {
    return {
      error: new AppError(
        "IDEMPOTENCY_CONFLICT",
        "That idempotency key was already used for a different order.",
        409,
      ),
    };
  }
  if (existing.outcome_type === "REJECTED") {
    return { error: parseStoredError(existing.error_json) };
  }
  return { receipt: parseStoredReceipt(existing.result_json) };
}

/**
 * Read an already-committed idempotent outcome without touching market data.
 * placeOrder repeats the same check inside its write transaction to close races.
 */
export async function replayOrder(
  input: PlaceOrderInput,
  systemTriggered = false,
): Promise<TradeReceipt | null> {
  const normalized = normalizeOrderInput(input, systemTriggered);
  const db = await getDb();
  const existing = await db.get<IdempotencyRecordRow>(
    `SELECT request_fingerprint, outcome_type, result_json, error_json
     FROM idempotency_records
     WHERE actor_user_id = ? AND idempotency_key = ?`,
    [normalized.actorUserId, normalized.idempotencyKey],
  );

  if (!existing) return null;

  const outcome = replayOutcome(existing, normalized.fingerprint);
  if (outcome.error) throw outcome.error;
  return outcome.receipt ?? null;
}

type PlaceOrderOutcome =
  | { kind: "receipt"; receipt: TradeReceipt }
  | { kind: "replayed-error"; error: AppError };

export async function placeOrder(
  input: PlaceOrderInput,
  options: FillOptions = {},
): Promise<TradeReceipt> {
  const normalized = normalizeOrderInput(input, options.systemTriggered);
  const db = await getDb();

  // Idempotent replays must resolve without touching market data, so the
  // stored outcome is consulted before the quote is read. The transaction
  // below re-checks under its own serialization to close the race.
  const replayed = await replayOrder(input, options.systemTriggered);
  if (replayed) {
    return replayed;
  }

  // Market data lives outside the ledger; read it before the write
  // transaction so no transaction ever waits on quote state.
  // One clock reading (the provider's, so injected test clocks agree with
  // the quotes they produce) drives the quote lookup and both freshness checks.
  const marketNow = options.now ?? marketDataNow();
  const quote =
    options.fillQuote?.symbol === normalized.symbol
      ? options.fillQuote
      : await requireQuote(normalized.symbol, marketNow);
  if (options.priceLimit) {
    const { side, limitCents } = options.priceLimit;
    if (side === "BUY" ? quote.priceCents > limitCents : quote.priceCents < limitCents) {
      throw new AppError(
        "WORKING_ORDER_PRICE_MOVED",
        "The price moved past the order's limit before it could fill.",
        409,
      );
    }
  }
  // A known price that may not trade, e.g. a crypto pair failing its data
  // checks or one valued at its last known price. Checked first so the
  // trader sees the specific reason. Nothing fills until the pair recovers.
  if (quote.tradingHaltReason) {
    throw new AppError("TRADING_HALTED", quote.tradingHaltReason, 409, {
      symbol: quote.symbol,
    });
  }
  if (quote.isStale) {
    throw new AppError(
      "MARKET_DATA_STALE",
      "Trading is paused because the latest market quote could not be refreshed.",
      503,
      { symbol: quote.symbol, quoteAsOf: quote.asOf },
    );
  }
  // A quote that refreshed successfully can still be old: a thinly traded
  // listing, an upstream that stopped updating, or a price carried over from
  // the previous session. Unparseable timestamps are treated as stale.
  const quoteAgeMs = marketNow.getTime() - Date.parse(quote.asOf);
  if (!Number.isFinite(quoteAgeMs) || quoteAgeMs > maxQuoteAgeMs()) {
    throw new AppError(
      "MARKET_DATA_STALE",
      `Trading in ${quote.symbol} is paused because the latest market quote is too old.`,
      503,
      { symbol: quote.symbol, quoteAsOf: quote.asOf },
    );
  }
  // Competition orders only fill during the listing's regular session, so
  // nobody can buy at a pre-news close after hours or over a weekend. The
  // admin sandbox is exempt; the transaction re-derives the same role.
  // marketClosesAt also guards a quote cached shortly before the bell.
  const marketOpen =
    quote.marketOpen &&
    (quote.marketClosesAt === null ||
      marketNow.getTime() < Date.parse(quote.marketClosesAt));
  if (!marketOpen) {
    const actor = await db.get<{ role: string }>(
      "SELECT role FROM users WHERE id = ?",
      [normalized.actorUserId],
    );
    if (actor?.role !== "platform_admin") {
      throw new AppError(
        "MARKET_CLOSED",
        `The market for ${quote.symbol} is closed. Orders can be placed during regular trading hours.`,
        409,
        { symbol: quote.symbol, opensAt: quote.marketOpensAt },
      );
    }
  }
  if (normalized.side === "BUY") assertBuyAllowed(quote);
  if (normalized.bracket) {
    assertBracketPrices(quote.priceCents, normalized.bracket, "current price");
  }
  const grossCents = quote.priceCadCents * normalized.quantity;
  if (!Number.isSafeInteger(grossCents)) {
    throw new AppError(
      "ORDER_TOO_LARGE",
      "This order is too large for the simulator.",
      400,
    );
  }

  const outcome = await db.transaction(async (tx): Promise<PlaceOrderOutcome> => {
    await acquireAccountReadLock(tx);
    if (tx.engine === "postgres") {
      // Serialize a trader's idempotency/rate-limit checks across instances.
      await tx.all("SELECT pg_advisory_xact_lock(823653, hashtext(?))", [normalized.actorUserId]);
      // Read holdings and cash only after obtaining the shared team's lock.
      await tx.all(
        `SELECT id FROM teams
         WHERE id IN (SELECT team_id FROM team_members WHERE user_id = ?)
            OR sandbox_owner_user_id = ?
         ORDER BY id FOR UPDATE`,
        [normalized.actorUserId, normalized.actorUserId],
      );
    }
    // Set once money has moved in this transaction. After that point any error,
    // even a business rejection, must roll everything back: recording it as a
    // rejection would commit a half-finished fill.
    let moneyMoved = false;
    try {
      const existing = await tx.get<IdempotencyRecordRow>(
        `SELECT request_fingerprint, outcome_type, result_json, error_json
         FROM idempotency_records
         WHERE actor_user_id = ? AND idempotency_key = ?`,
        [normalized.actorUserId, normalized.idempotencyKey],
      );

      if (existing) {
        // Commit the (empty) transaction and surface the stored outcome.
        const stored = replayOutcome(existing, normalized.fingerprint);
        return stored.error
          ? { kind: "replayed-error", error: stored.error }
          : { kind: "receipt", receipt: stored.receipt as TradeReceipt };
      }

      const rateLimit = options.systemTriggered
        ? Number.POSITIVE_INFINITY
        : maxOrdersPerMinute();
      const windowStartIso = new Date(
        Date.now() - ORDER_RATE_WINDOW_MS,
      ).toISOString();
      // Fills triggered by waiting orders (keys starting "working:") are the
      // system acting, so they never use up a trader's own allowance.
      const recentAttempts = await tx.get<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM idempotency_records
         WHERE actor_user_id = ? AND created_at > ?
           AND idempotency_key NOT LIKE 'working:%'`,
        [normalized.actorUserId, windowStartIso],
      );

      if (Number(recentAttempts?.count ?? 0) >= rateLimit) {
        const oldestCounted = await tx.get<{ created_at: string }>(
          `SELECT created_at
           FROM idempotency_records
           WHERE actor_user_id = ? AND created_at > ?
             AND idempotency_key NOT LIKE 'working:%'
           ORDER BY created_at ASC
           LIMIT 1`,
          [normalized.actorUserId, windowStartIso],
        );
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil(
            (Date.parse(oldestCounted?.created_at ?? windowStartIso) +
              ORDER_RATE_WINDOW_MS -
              Date.now()) /
              1_000,
          ),
        );

        throw new AppError(
          "ORDER_RATE_LIMITED",
          `Slow down: at most ${rateLimit} orders per minute per trader. Try again shortly.`,
          429,
          { retryAfterSeconds, limitPerMinute: rateLimit },
        );
      }

      const account = await tx.get<TradingAccountRow>(
        `SELECT
           u.id AS user_id, u.name AS actor_name, u.role, u.status AS user_status,
           t.id AS team_id, t.sandbox_owner_user_id,
           t.name AS team_name, t.status AS team_status, t.cash_cents, t.version,
           c.id AS competition_id, c.status AS competition_status,
           c.starts_at AS competition_starts_at, c.ends_at AS competition_ends_at
         FROM users u
         LEFT JOIN team_members tm ON tm.user_id = u.id AND u.role = 'student'
         LEFT JOIN teams t ON
           (u.role = 'student' AND t.id = tm.team_id)
           OR
           (u.role = 'platform_admin' AND t.sandbox_owner_user_id = u.id)
         LEFT JOIN competitions c ON c.id = t.competition_id
         WHERE u.id = ?`,
        [normalized.actorUserId],
      );

      if (!account) {
        throw new AppError("UNAUTHORIZED", "Sign in before placing an order.", 401);
      }
      // A waiting order's placer who has left its team can never fill it;
      // checked first so no team-status refusal makes it wait forever.
      if (options.expectTeamId && account.team_id !== options.expectTeamId) {
        throw new AppError(
          "WORKING_ORDER_TEAM_CHANGED",
          "The person who placed this order is no longer on the team.",
          409,
        );
      }
      if (account.user_status !== "active") {
        throw new AppError("ACCOUNT_SUSPENDED", "This account is suspended.", 403);
      }
      if (account.role === "host") {
        throw new AppError(
          "HOST_CANNOT_TRADE",
          "Host accounts cannot trade in a team portfolio.",
          403,
        );
      }
      const isAdminSandbox = account.role === "platform_admin";
      if (
        isAdminSandbox &&
        (!account.team_id ||
          account.sandbox_owner_user_id !== normalized.actorUserId)
      ) {
        throw new AppError(
          "ADMIN_TRADING_ACCOUNT_REQUIRED",
          "Set test-account cash before placing an admin sandbox order.",
          403,
        );
      }
      if (
        !account.team_id ||
        !account.team_name ||
        account.cash_cents === null ||
        account.version === null ||
        !account.competition_id
      ) {
        throw new AppError(
          isAdminSandbox ? "ADMIN_TRADING_ACCOUNT_REQUIRED" : "TEAM_REQUIRED",
          isAdminSandbox
            ? "Set test-account cash before placing an admin sandbox order."
            : "Join a team before trading.",
          403,
        );
      }
      if (!isAdminSandbox && account.competition_status !== "active") {
        throw new AppError(
          "TRADING_CLOSED",
          account.competition_status === "paused"
            ? "Trading is temporarily paused by the host."
            : "This competition is not accepting trades.",
          409,
          { competitionStatus: account.competition_status },
        );
      }

      // The schedule window is the automatic start/stop switch: an active
      // competition only accepts orders between its start and end instants.
      // Checked inside the same transaction as the balance mutation so a
      // trade can never slip through around the boundary.
      const nowIso = new Date().toISOString();
      if (
        !isAdminSandbox &&
        account.competition_starts_at &&
        nowIso < account.competition_starts_at
      ) {
        throw new AppError(
          "TRADING_CLOSED",
          "Trading has not opened yet for this competition.",
          409,
          {
            competitionStatus: "scheduled",
            opensAt: account.competition_starts_at,
          },
        );
      }
      if (
        !isAdminSandbox &&
        account.competition_ends_at &&
        nowIso >= account.competition_ends_at
      ) {
        throw new AppError(
          "TRADING_CLOSED",
          "This competition has ended.",
          409,
          { competitionStatus: "ended", endedAt: account.competition_ends_at },
        );
      }
      if (!isAdminSandbox && account.team_status !== "active") {
        throw new AppError(
          "TEAM_NOT_ACTIVE",
          account.team_status === "frozen"
            ? "This team is frozen. Ask the host to restore trading."
            : "This team is disqualified and cannot trade.",
          409,
          { teamStatus: account.team_status },
        );
      }

      if (normalized.bracket && !workingOrdersAvailableTo(account.role)) {
        throw new AppError(
          "WORKING_ORDERS_DISABLED",
          "Take profit and stop loss orders aren't open in this competition yet.",
          409,
        );
      }
      if (normalized.bracket) {
        const exits =
          (normalized.bracket.takeProfitCents ? 1 : 0) +
          (normalized.bracket.stopLossCents ? 1 : 0);
        const open = await countOpenWorkingOrders(tx, account.team_id);
        if (open + exits > MAX_OPEN_WORKING_ORDERS_PER_TEAM) {
          throw new AppError(
            "TOO_MANY_WORKING_ORDERS",
            `A team can have at most ${MAX_OPEN_WORKING_ORDERS_PER_TEAM} waiting orders. Cancel one first.`,
            409,
          );
        }
      }
      if (options.beforeFill) {
        await options.beforeFill(tx);
      }

      const holding = await tx.get<HoldingRow>(
        `SELECT quantity, average_cost_cents
         FROM holdings
         WHERE team_id = ? AND symbol = ?`,
        [account.team_id, normalized.symbol],
      );
      const currentQuantity = Number(holding?.quantity ?? 0);
      // Cash and shares set aside for the team's waiting orders aren't
      // available to this order, unless this fill is one of those orders.
      const reservations = await readReservations(
        tx,
        account.team_id,
        options.releaseWorkingOrderIds,
      );
      const reservedShares = reservations.sharesBySymbol.get(normalized.symbol) ?? 0;
      const spendableCashCents = Number(account.cash_cents) - reservations.cashCents;
      const sellableQuantity = currentQuantity - reservedShares;
      const currentAverageCostCents = Number(holding?.average_cost_cents ?? 0);
      const shareWord = unitWord(quote.assetClass, normalized.quantity);
      // Crypto notes also give the token amount, e.g. "3 lots (0.0003 BTC)".
      const amountText =
        quote.assetClass === "CRYPTO"
          ? `${normalized.quantity} ${shareWord} (${formatTokenQuantity(normalized.quantity, quote.lotSize)} ${cryptoTokenSymbol(normalized.symbol)})`
          : `${normalized.quantity} ${shareWord}`;
      let cashAfterCents: number;
      let holdingQuantityAfter: number;
      let averageCostAfterCents: number;

      if (normalized.side === "BUY") {
        if (grossCents > spendableCashCents) {
          throw new AppError(
            "INSUFFICIENT_CASH",
            (isAdminSandbox
              ? "The test account does not have enough buying power for this order."
              : "The team does not have enough buying power for this order.") +
              (reservations.cashCents > 0
                ? " Some cash is set aside for waiting orders."
                : ""),
            409,
            {
              availableCents: spendableCashCents,
              requiredCents: grossCents,
              reservedCents: reservations.cashCents,
            },
          );
        }
        cashAfterCents = Number(account.cash_cents) - grossCents;
        holdingQuantityAfter = currentQuantity + normalized.quantity;
        averageCostAfterCents = Math.round(
          (currentQuantity * currentAverageCostCents + grossCents) /
            holdingQuantityAfter,
        );
      } else {
        if (normalized.quantity > sellableQuantity) {
          throw new AppError(
            "INSUFFICIENT_SHARES",
            reservedShares > 0 && normalized.quantity <= currentQuantity
              ? `${reservedShares} ${unitWord(quote.assetClass, reservedShares)} of ${normalized.symbol} ${reservedShares === 1 ? "is" : "are"} held for waiting sell orders. Cancel those first, or sell at most ${Math.max(0, sellableQuantity)}.`
              : `${isAdminSandbox ? "The test account" : "The team"} only owns ${currentQuantity} ${unitWord(quote.assetClass, currentQuantity)} of ${normalized.symbol}.`,
            409,
            {
              availableShares: Math.max(0, sellableQuantity),
              requestedShares: normalized.quantity,
              reservedShares,
            },
          );
        }
        cashAfterCents = Number(account.cash_cents) + grossCents;
        holdingQuantityAfter = currentQuantity - normalized.quantity;
        averageCostAfterCents = currentAverageCostCents;
      }

      const portfolioVersion = Number(account.version) + 1;
      moneyMoved = true;
      const teamUpdate = await tx.run(
        `UPDATE teams SET cash_cents = ?, version = version + 1
         WHERE id = ? AND version = ?`,
        [cashAfterCents, account.team_id, account.version],
      );
      if (teamUpdate.changes !== 1) {
        throw new AppError(
          "PORTFOLIO_CONFLICT",
          "The portfolio changed while this order was being processed. Retry safely with the same idempotency key.",
          409,
        );
      }

      const createdAt = new Date().toISOString();
      if (holdingQuantityAfter === 0) {
        await tx.run("DELETE FROM holdings WHERE team_id = ? AND symbol = ?", [
          account.team_id,
          normalized.symbol,
        ]);
      } else if (holding) {
        await tx.run(
          `UPDATE holdings
           SET quantity = ?, average_cost_cents = ?, updated_at = ?
           WHERE team_id = ? AND symbol = ?`,
          [
            holdingQuantityAfter,
            averageCostAfterCents,
            createdAt,
            account.team_id,
            normalized.symbol,
          ],
        );
      } else {
        await tx.run(
          `INSERT INTO holdings (
             team_id, symbol, quantity, average_cost_cents, updated_at
           ) VALUES (?, ?, ?, ?, ?)`,
          [
            account.team_id,
            normalized.symbol,
            holdingQuantityAfter,
            averageCostAfterCents,
            createdAt,
          ],
        );
      }

      const orderId = randomUUID();
      await tx.run(
        `INSERT INTO orders (
           id, idempotency_key, request_fingerprint, team_id, actor_user_id,
           symbol, side, quantity, fill_price_cents, fill_price_cad_cents,
           gross_cents, cash_after_cents, holding_quantity_after,
           portfolio_version, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'FILLED', ?)`,
        [
          orderId,
          `${normalized.actorUserId}:${normalized.idempotencyKey}`,
          normalized.fingerprint,
          account.team_id,
          normalized.actorUserId,
          normalized.symbol,
          normalized.side,
          normalized.quantity,
          quote.priceCents,
          quote.priceCadCents,
          grossCents,
          cashAfterCents,
          holdingQuantityAfter,
          portfolioVersion,
          createdAt,
        ],
      );

      const verb = normalized.side === "BUY" ? "Bought" : "Sold";
      await tx.run(
        `INSERT INTO ledger_entries (
           id, team_id, order_id, entry_type, amount_cents,
           symbol, quantity, note, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          account.team_id,
          orderId,
          normalized.side,
          normalized.side === "BUY" ? -grossCents : grossCents,
          normalized.symbol,
          normalized.quantity,
          `${verb} ${amountText} of ${normalized.symbol}`,
          createdAt,
        ],
      );
      await tx.run(
        `INSERT INTO activity_events (
           id, competition_id, team_id, actor_user_id, type,
           title, detail, created_at
         ) VALUES (?, ?, ?, ?, 'ORDER_FILLED', ?, ?, ?)`,
        [
          randomUUID(),
          account.competition_id,
          account.team_id,
          normalized.actorUserId,
          options.activityLabel
            ? `${options.activityLabel}: ${normalized.side} ${normalized.symbol}`
            : `${normalized.side} ${normalized.symbol}`,
          options.activityLabel
            ? `${options.activityLabel} triggered: ${account.actor_name}'s order ${verb.toLowerCase()} ${amountText} of ${normalized.symbol}.`
            : `${account.actor_name} ${verb.toLowerCase()} ${amountText} of ${normalized.symbol}.`,
          createdAt,
        ],
      );

      const order: OrderView = {
        id: orderId,
        idempotencyKey: normalized.idempotencyKey,
        teamId: account.team_id,
        teamName: account.team_name,
        actorUserId: normalized.actorUserId,
        actorName: account.actor_name,
        symbol: normalized.symbol,
        side: normalized.side,
        quantity: normalized.quantity,
        fillPriceCents: quote.priceCents,
        fillPriceCadCents: quote.priceCadCents,
        grossCents,
        status: "FILLED",
        createdAt,
      };
      const receipt: TradeReceipt = {
        order,
        cashAfterCents,
        holdingQuantityAfter,
        portfolioVersion,
        duplicate: false,
      };

      await tx.run(
        `INSERT INTO idempotency_records (
           actor_user_id, idempotency_key, request_fingerprint, outcome_type,
           order_id, result_json, error_json, created_at
         ) VALUES (?, ?, ?, 'FILLED', ?, ?, NULL, ?)`,
        [
          normalized.actorUserId,
          normalized.idempotencyKey,
          normalized.fingerprint,
          orderId,
          JSON.stringify(receipt),
          createdAt,
        ],
      );

      // A bracket's exits start watching the price as soon as the buy fills.
      if (normalized.bracket) {
        await insertBracketExits(tx, {
          teamId: account.team_id,
          actorUserId: normalized.actorUserId,
          idempotencyKey: `bracket:${orderId}`,
          symbol: normalized.symbol,
          quantity: normalized.quantity,
          takeProfitCents: normalized.bracket.takeProfitCents,
          stopLossCents: normalized.bracket.stopLossCents,
          timeInForce: normalized.bracket.timeInForce,
          expiresAt: workingOrderExpiresAt(
            normalized.bracket.timeInForce,
            quote.assetClass,
            new Date(createdAt),
            quote.listingCurrency,
          ),
          status: "WORKING",
          parentId: null,
          now: createdAt,
        });
      }
      if (options.afterFill) {
        await options.afterFill(tx, {
          orderId,
          teamId: account.team_id,
          competitionId: account.competition_id,
          actorName: account.actor_name,
        });
      }

      await assertTeamLedgerReconciles([account.team_id], tx);
      return { kind: "receipt", receipt };
    } catch (error) {
      // Persist business rejections while still holding the trader's lock,
      // so a simultaneous retry cannot commit a contradictory outcome.
      if (!moneyMoved && shouldPersistRejection(error)) {
        await tx.run(
          `INSERT INTO idempotency_records (
             actor_user_id, idempotency_key, request_fingerprint, outcome_type,
             order_id, result_json, error_json, created_at
           ) VALUES (?, ?, ?, 'REJECTED', NULL, NULL, ?, ?)`,
          [
            normalized.actorUserId,
            normalized.idempotencyKey,
            normalized.fingerprint,
            JSON.stringify(error.toJSON()),
            new Date().toISOString(),
          ],
        );
        return { kind: "replayed-error", error };
      }
      throw error;
    }
  });

  if (outcome.kind === "replayed-error") {
    throw outcome.error;
  }

  return outcome.receipt;
}
