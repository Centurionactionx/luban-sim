import { randomUUID } from "node:crypto";

import type {
  CompetitionStatus,
  OrderView,
  PlaceOrderInput,
  SerializedAppError,
  TeamStatus,
  TradeReceipt,
  TradeSide,
} from "../contracts";
import { AppError } from "../errors";
import { acquireAccountReadLock } from "./database";
import { cryptoTokenSymbol, formatTokenQuantity, unitWord } from "../lots";
import { assertTeamLedgerReconciles, getDb } from "./db";
import {
  isAssetClassEnabled,
  isSymbolBlocked,
  MARKET_SYMBOL_PATTERN,
  marketDataNow,
  normalizeMarketSymbol,
  requireQuote,
} from "./quotes";

const MAX_ORDER_QUANTITY = 100_000;
const DEFAULT_MAX_ORDERS_PER_MINUTE = 20;
const ORDER_RATE_WINDOW_MS = 60_000;
const DEFAULT_MAX_QUOTE_AGE_MINUTES = 20;
/** New crypto buys need a lot worth at least $1, or rounding gets too coarse. */
const MIN_CRYPTO_LOT_CAD_CENTS = 100;

/**
 * Oldest quote an order may fill against. Free TSX data runs about fifteen
 * minutes behind, so the default leaves a small margin above that delay
 * while refusing fills at prices from a previous session or a dead feed.
 */
function maxQuoteAgeMs(): number {
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

interface NormalizedOrderInput {
  actorUserId: string;
  symbol: string;
  side: TradeSide;
  quantity: number;
  idempotencyKey: string;
  fingerprint: string;
}

function normalizeOrderInput(input: PlaceOrderInput): NormalizedOrderInput {
  const actorUserId = input.actorUserId?.trim();
  const symbol = input.symbol ? normalizeMarketSymbol(input.symbol) : "";
  const side = String(input.side ?? "").toUpperCase();
  const idempotencyKey = input.idempotencyKey?.trim();

  if (!actorUserId) {
    throw new AppError("UNAUTHORIZED", "Sign in before placing an order.", 401);
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
  return {
    actorUserId,
    symbol,
    side: normalizedSide,
    quantity: input.quantity,
    idempotencyKey,
    fingerprint: `${actorUserId}|${symbol}|${normalizedSide}|${input.quantity}`,
  };
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
    error.code !== "ORDER_RATE_LIMITED"
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
): Promise<TradeReceipt | null> {
  const normalized = normalizeOrderInput(input);
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

export async function placeOrder(input: PlaceOrderInput): Promise<TradeReceipt> {
  const normalized = normalizeOrderInput(input);
  const db = await getDb();

  // Idempotent replays must resolve without touching market data, so the
  // stored outcome is consulted before the quote is read. The transaction
  // below re-checks under its own serialization to close the race.
  const replayed = await replayOrder(input);
  if (replayed) {
    return replayed;
  }

  // Market data lives outside the ledger; read it before the write
  // transaction so no transaction ever waits on quote state.
  // One clock reading (the provider's, so injected test clocks agree with
  // the quotes they produce) drives the quote lookup and both freshness checks.
  const marketNow = marketDataNow();
  const quote = await requireQuote(normalized.symbol, marketNow);
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
  // Switching an asset class off or blocking a symbol stops new buys only,
  // so nobody is ever trapped in a position they cannot sell.
  if (normalized.side === "BUY") {
    if (!isAssetClassEnabled(quote.assetClass)) {
      throw new AppError(
        "ASSET_CLASS_DISABLED",
        `${quote.assetClass === "CRYPTO" ? "Crypto" : "ETF"} trading is not open in this competition.`,
        409,
        { symbol: quote.symbol, assetClass: quote.assetClass },
      );
    }
    if (isSymbolBlocked(quote.symbol)) {
      throw new AppError(
        "SYMBOL_BLOCKED",
        `${quote.symbol} has been removed from the simulator. Existing holdings can still be sold.`,
        409,
        { symbol: quote.symbol },
      );
    }
    if (
      quote.assetClass === "CRYPTO" &&
      quote.priceCadCents < MIN_CRYPTO_LOT_CAD_CENTS
    ) {
      throw new AppError(
        "LOT_TOO_SMALL",
        `One lot of ${quote.symbol} is now worth less than $1, so new buys are paused. You can still sell.`,
        409,
        { symbol: quote.symbol },
      );
    }
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

      const rateLimit = maxOrdersPerMinute();
      const windowStartIso = new Date(
        Date.now() - ORDER_RATE_WINDOW_MS,
      ).toISOString();
      const recentAttempts = await tx.get<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM idempotency_records
         WHERE actor_user_id = ? AND created_at > ?`,
        [normalized.actorUserId, windowStartIso],
      );

      if (Number(recentAttempts?.count ?? 0) >= rateLimit) {
        const oldestCounted = await tx.get<{ created_at: string }>(
          `SELECT created_at
           FROM idempotency_records
           WHERE actor_user_id = ? AND created_at > ?
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

      const holding = await tx.get<HoldingRow>(
        `SELECT quantity, average_cost_cents
         FROM holdings
         WHERE team_id = ? AND symbol = ?`,
        [account.team_id, normalized.symbol],
      );
      const currentQuantity = Number(holding?.quantity ?? 0);
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
        if (grossCents > Number(account.cash_cents)) {
          throw new AppError(
            "INSUFFICIENT_CASH",
            isAdminSandbox
              ? "The test account does not have enough buying power for this order."
              : "The team does not have enough buying power for this order.",
            409,
            {
              availableCents: Number(account.cash_cents),
              requiredCents: grossCents,
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
        if (normalized.quantity > currentQuantity) {
          throw new AppError(
            "INSUFFICIENT_SHARES",
            `${isAdminSandbox ? "The test account" : "The team"} only owns ${currentQuantity} ${unitWord(quote.assetClass, currentQuantity)} of ${normalized.symbol}.`,
            409,
            {
              availableShares: currentQuantity,
              requestedShares: normalized.quantity,
            },
          );
        }
        cashAfterCents = Number(account.cash_cents) + grossCents;
        holdingQuantityAfter = currentQuantity - normalized.quantity;
        averageCostAfterCents = currentAverageCostCents;
      }

      const portfolioVersion = Number(account.version) + 1;
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
          `${normalized.side} ${normalized.symbol}`,
          `${account.actor_name} ${verb.toLowerCase()} ${amountText} of ${normalized.symbol}.`,
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

      await assertTeamLedgerReconciles([account.team_id], tx);
      return { kind: "receipt", receipt };
    } catch (error) {
      // Persist business rejections while still holding the trader's lock,
      // so a simultaneous retry cannot commit a contradictory outcome.
      if (shouldPersistRejection(error)) {
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
