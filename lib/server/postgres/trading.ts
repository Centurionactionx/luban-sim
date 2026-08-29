import { randomUUID } from "node:crypto";

import type {
  CompetitionStatus,
  OrderView,
  PlaceOrderInput,
  Quote,
  SerializedAppError,
  TeamStatus,
  TradeReceipt,
  TradeSide,
} from "../../contracts";
import { AppError } from "../../errors";
import { normalizeMarketSymbol } from "../quotes";
import { getPostgresClient, type PostgresExecutor } from "./client";
import { ensurePostgresInstrumentForQuote } from "./quotes";

const MAX_ORDER_QUANTITY = 100_000;
type DatabaseInteger = bigint | number | string;

interface IdempotencyRecordRow {
  request_fingerprint: string;
  outcome_type: "FILLED" | "REJECTED";
  result_json: string | null;
  error_json: string | null;
}

interface UserTeamRow {
  user_id: string;
  actor_name: string;
  role: "student" | "host";
  team_id: string | null;
}

interface TradingAccountRow {
  team_id: string;
  team_name: string;
  team_status: TeamStatus;
  cash_cents: DatabaseInteger;
  version: DatabaseInteger;
  competition_id: string;
}

interface CompetitionLockRow {
  competition_id: string;
  competition_status: CompetitionStatus;
}

interface HoldingRow {
  quantity: DatabaseInteger;
  average_cost_cents: DatabaseInteger;
}

interface NormalizedOrderInput {
  actorUserId: string;
  symbol: string;
  side: TradeSide;
  quantity: number;
  idempotencyKey: string;
  fingerprint: string;
}

interface TransactionResult {
  receipt?: TradeReceipt;
  rejection?: AppError;
}

function databaseInteger(value: DatabaseInteger, field: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized)) {
    throw new AppError(
      "DATABASE_VALUE_OUT_OF_RANGE",
      `The stored ${field} value is outside the supported integer range.`,
      500,
    );
  }
  return normalized;
}

function safeIntegerFromBigInt(value: bigint, field: string): number {
  if (
    value > BigInt(Number.MAX_SAFE_INTEGER) ||
    value < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    throw new AppError(
      "CALCULATION_OUT_OF_RANGE",
      `The calculated ${field} value is outside the supported integer range.`,
      400,
    );
  }
  return Number(value);
}

function roundedAverageCost(
  currentQuantity: number,
  currentAverageCostCents: number,
  purchasedQuantity: number,
  grossCents: number,
): { averageCostCents: number; quantity: number } {
  const quantity = safeIntegerFromBigInt(
    BigInt(currentQuantity) + BigInt(purchasedQuantity),
    "holding quantity",
  );
  const numerator =
    BigInt(currentQuantity) * BigInt(currentAverageCostCents) +
    BigInt(grossCents);
  const divisor = BigInt(quantity);
  const averageCostCents = safeIntegerFromBigInt(
    (numerator + divisor / BigInt(2)) / divisor,
    "average cost",
  );
  return { averageCostCents, quantity };
}

function normalizeOrderInput(input: PlaceOrderInput): NormalizedOrderInput {
  const actorUserId = input.actorUserId?.trim();
  const symbol = input.symbol ? normalizeMarketSymbol(input.symbol) : "";
  const side = String(input.side ?? "").toUpperCase();
  const idempotencyKey = input.idempotencyKey?.trim();

  if (!actorUserId) {
    throw new AppError("UNAUTHORIZED", "Sign in before placing an order.", 401);
  }
  if (!symbol || !/^[A-Z0-9.-]{1,16}$/.test(symbol)) {
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
      // Fall through to the invariant error.
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
      // Fall through to the invariant error.
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
    error.code !== "PORTFOLIO_CONFLICT"
  );
}

async function readIdempotencyRecord(
  database: PostgresExecutor,
  input: NormalizedOrderInput,
): Promise<IdempotencyRecordRow | null> {
  const rows = await database<IdempotencyRecordRow[]>`
    SELECT request_fingerprint, outcome_type, result_json, error_json
    FROM public.idempotency_records
    WHERE actor_user_id = ${input.actorUserId}
      AND idempotency_key = ${input.idempotencyKey}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

function replayRecord(
  record: IdempotencyRecordRow,
  fingerprint: string,
): TradeReceipt {
  if (record.request_fingerprint !== fingerprint) {
    throw new AppError(
      "IDEMPOTENCY_CONFLICT",
      "That idempotency key was already used for a different order.",
      409,
    );
  }
  if (record.outcome_type === "REJECTED") {
    throw parseStoredError(record.error_json);
  }
  return parseStoredReceipt(record.result_json);
}

async function assertTeamLedger(
  database: PostgresExecutor,
  teamId: string,
): Promise<void> {
  const rows = await database<
    Array<{
      cash_cents: DatabaseInteger;
      ledger_balance_cents: DatabaseInteger;
    }>
  >`
    SELECT
      t.cash_cents,
      COALESCE(SUM(l.amount_cents), 0)::bigint AS ledger_balance_cents
    FROM public.teams AS t
    LEFT JOIN public.ledger_entries AS l ON l.team_id = t.id
    WHERE t.id = ${teamId}
    GROUP BY t.id, t.cash_cents
  `;
  const row = rows[0];
  if (
    !row ||
    databaseInteger(row.cash_cents, "team cash") !==
      databaseInteger(row.ledger_balance_cents, "ledger balance")
  ) {
    throw new AppError(
      "LEDGER_OUT_OF_BALANCE",
      "The team cash balance does not reconcile to its ledger.",
      500,
      { teamId },
    );
  }
}

export async function replayPostgresOrder(
  input: PlaceOrderInput,
): Promise<TradeReceipt | null> {
  const normalized = normalizeOrderInput(input);
  const existing = await readIdempotencyRecord(
    getPostgresClient(),
    normalized,
  );
  return existing ? replayRecord(existing, normalized.fingerprint) : null;
}

export async function placePostgresOrder(
  input: PlaceOrderInput,
  quote: Quote,
): Promise<TradeReceipt> {
  const normalized = normalizeOrderInput(input);

  if (normalizeMarketSymbol(quote.symbol) !== normalized.symbol) {
    throw new AppError(
      "QUOTE_SYMBOL_MISMATCH",
      "The refreshed quote does not match the requested symbol.",
      500,
    );
  }
  if (quote.isStale) {
    throw new AppError(
      "MARKET_DATA_STALE",
      "Trading is paused because the latest market quote could not be refreshed.",
      503,
      { symbol: quote.symbol, quoteAsOf: quote.asOf },
    );
  }

  const quotePriceCadCents = databaseInteger(
    quote.priceCadCents,
    "CAD quote price",
  );
  let grossCents: number;
  try {
    grossCents = safeIntegerFromBigInt(
      BigInt(quotePriceCadCents) * BigInt(normalized.quantity),
      "order gross",
    );
  } catch (error) {
    if (error instanceof AppError && error.code === "CALCULATION_OUT_OF_RANGE") {
      throw new AppError(
        "ORDER_TOO_LARGE",
        "This order is too large for the simulator.",
        400,
      );
    }
    throw error;
  }

  const client = getPostgresClient();
  const result = await client.begin(async (database): Promise<TransactionResult> => {
    await database`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`${normalized.actorUserId}:${normalized.idempotencyKey}`}, 0)
      )
    `;

    const existing = await readIdempotencyRecord(database, normalized);
    if (existing) {
      return { receipt: replayRecord(existing, normalized.fingerprint) };
    }

    let writesStarted = false;
    try {
      const users = await database<UserTeamRow[]>`
        SELECT
          u.id AS user_id,
          u.name AS actor_name,
          u.role,
          tm.team_id
        FROM public.users AS u
        LEFT JOIN public.team_members AS tm ON tm.user_id = u.id
        WHERE u.id = ${normalized.actorUserId}
        LIMIT 1
      `;
      const user = users[0];

      if (!user) {
        throw new AppError("UNAUTHORIZED", "Sign in before placing an order.", 401);
      }
      if (user.role !== "student") {
        throw new AppError(
          "HOST_CANNOT_TRADE",
          "Host accounts cannot trade in a team portfolio.",
          403,
        );
      }
      if (!user.team_id) {
        throw new AppError("TEAM_REQUIRED", "Join a team before trading.", 403);
      }

      // Lock competition state before the team. A host pause takes an
      // exclusive lock on the same competition row, so a trade cannot observe
      // "active" and then commit after the pause has completed.
      const competitions = await database<CompetitionLockRow[]>`
        SELECT
          c.id AS competition_id,
          c.status AS competition_status
        FROM public.teams AS t
        JOIN public.competitions AS c ON c.id = t.competition_id
        WHERE t.id = ${user.team_id}
        FOR SHARE OF c
      `;
      const competition = competitions[0];
      if (!competition) {
        throw new AppError("TEAM_REQUIRED", "Join a team before trading.", 403);
      }
      if (competition.competition_status !== "active") {
        throw new AppError(
          "TRADING_CLOSED",
          competition.competition_status === "paused"
            ? "Trading is temporarily paused by the host."
            : "This competition is not accepting trades.",
          409,
          { competitionStatus: competition.competition_status },
        );
      }

      const accounts = await database<TradingAccountRow[]>`
        SELECT
          t.id AS team_id,
          t.name AS team_name,
          t.status AS team_status,
          t.cash_cents,
          t.version,
          t.competition_id
        FROM public.teams AS t
        WHERE t.id = ${user.team_id}
          AND t.competition_id = ${competition.competition_id}
        FOR UPDATE OF t
      `;
      const account = accounts[0];
      if (!account) {
        throw new AppError("TEAM_REQUIRED", "Join a team before trading.", 403);
      }
      if (account.team_status !== "active") {
        throw new AppError(
          "TEAM_NOT_ACTIVE",
          account.team_status === "frozen"
            ? "This team is frozen. Ask the host to restore trading."
            : "This team is disqualified and cannot trade.",
          409,
          { teamStatus: account.team_status },
        );
      }

      const holdings = await database<HoldingRow[]>`
        SELECT quantity, average_cost_cents
        FROM public.holdings
        WHERE team_id = ${account.team_id} AND symbol = ${normalized.symbol}
        FOR UPDATE
      `;
      const holding = holdings[0];
      const currentQuantity = databaseInteger(
        holding?.quantity ?? 0,
        "holding quantity",
      );
      const currentAverageCostCents = databaseInteger(
        holding?.average_cost_cents ?? 0,
        "average cost",
      );
      const cashCents = databaseInteger(account.cash_cents, "team cash");
      let cashAfterCents: number;
      let holdingQuantityAfter: number;
      let averageCostAfterCents: number;

      if (normalized.side === "BUY") {
        if (grossCents > cashCents) {
          throw new AppError(
            "INSUFFICIENT_CASH",
            "The team does not have enough buying power for this order.",
            409,
            { availableCents: cashCents, requiredCents: grossCents },
          );
        }
        cashAfterCents = safeIntegerFromBigInt(
          BigInt(cashCents) - BigInt(grossCents),
          "cash balance",
        );
        const averaged = roundedAverageCost(
          currentQuantity,
          currentAverageCostCents,
          normalized.quantity,
          grossCents,
        );
        holdingQuantityAfter = averaged.quantity;
        averageCostAfterCents = averaged.averageCostCents;
      } else {
        if (normalized.quantity > currentQuantity) {
          throw new AppError(
            "INSUFFICIENT_SHARES",
            `The team only owns ${currentQuantity} ${currentQuantity === 1 ? "share" : "shares"} of ${normalized.symbol}.`,
            409,
            {
              availableShares: currentQuantity,
              requestedShares: normalized.quantity,
            },
          );
        }
        cashAfterCents = safeIntegerFromBigInt(
          BigInt(cashCents) + BigInt(grossCents),
          "cash balance",
        );
        holdingQuantityAfter = safeIntegerFromBigInt(
          BigInt(currentQuantity) - BigInt(normalized.quantity),
          "holding quantity",
        );
        averageCostAfterCents = currentAverageCostCents;
      }

      await ensurePostgresInstrumentForQuote(quote, database);
      writesStarted = true;
      const versions = await database<Array<{ version: string | number }>>`
        UPDATE public.teams
        SET cash_cents = ${cashAfterCents}, version = version + 1
        WHERE id = ${account.team_id}
        RETURNING version
      `;
      const portfolioVersion = Number(versions[0]?.version);
      if (!Number.isSafeInteger(portfolioVersion)) {
        throw new AppError(
          "PORTFOLIO_CONFLICT",
          "The portfolio changed while this order was being processed.",
          409,
        );
      }

      const createdAt = new Date();
      if (holdingQuantityAfter === 0) {
        await database`
          DELETE FROM public.holdings
          WHERE team_id = ${account.team_id} AND symbol = ${normalized.symbol}
        `;
      } else {
        await database`
          INSERT INTO public.holdings (
            team_id, symbol, quantity, average_cost_cents, updated_at
          ) VALUES (
            ${account.team_id}, ${normalized.symbol}, ${holdingQuantityAfter},
            ${averageCostAfterCents}, ${createdAt}
          )
          ON CONFLICT (team_id, symbol) DO UPDATE SET
            quantity = EXCLUDED.quantity,
            average_cost_cents = EXCLUDED.average_cost_cents,
            updated_at = EXCLUDED.updated_at
        `;
      }

      const orderId = randomUUID();
      await database`
        INSERT INTO public.orders (
          id, idempotency_key, request_fingerprint, team_id, actor_user_id,
          symbol, side, quantity, fill_price_cents, fill_price_cad_cents,
          gross_cents, cash_after_cents, holding_quantity_after,
          portfolio_version, status, created_at
        ) VALUES (
          ${orderId},
          ${`${normalized.actorUserId}:${normalized.idempotencyKey}`},
          ${normalized.fingerprint}, ${account.team_id},
          ${normalized.actorUserId}, ${normalized.symbol}, ${normalized.side},
          ${normalized.quantity}, ${quote.priceCents}, ${quote.priceCadCents},
          ${grossCents}, ${cashAfterCents}, ${holdingQuantityAfter},
          ${portfolioVersion}, 'FILLED', ${createdAt}
        )
      `;

      const verb = normalized.side === "BUY" ? "Bought" : "Sold";
      const shareWord = normalized.quantity === 1 ? "share" : "shares";
      await database`
        INSERT INTO public.ledger_entries (
          id, team_id, order_id, entry_type, amount_cents,
          symbol, quantity, note, created_at
        ) VALUES (
          ${randomUUID()}, ${account.team_id}, ${orderId}, ${normalized.side},
          ${normalized.side === "BUY" ? -grossCents : grossCents},
          ${normalized.symbol}, ${normalized.quantity},
          ${`${verb} ${normalized.quantity} ${shareWord} of ${normalized.symbol}`},
          ${createdAt}
        )
      `;
      await database`
        INSERT INTO public.activity_events (
          id, competition_id, team_id, actor_user_id, type,
          title, detail, created_at
        ) VALUES (
          ${randomUUID()}, ${account.competition_id}, ${account.team_id},
          ${normalized.actorUserId}, 'ORDER_FILLED',
          ${`${normalized.side} ${normalized.symbol}`},
          ${`${user.actor_name} ${verb.toLowerCase()} ${normalized.quantity} ${shareWord} of ${normalized.symbol}.`},
          ${createdAt}
        )
      `;

      const order: OrderView = {
        id: orderId,
        idempotencyKey: normalized.idempotencyKey,
        teamId: account.team_id,
        teamName: account.team_name,
        actorUserId: normalized.actorUserId,
        actorName: user.actor_name,
        symbol: normalized.symbol,
        side: normalized.side,
        quantity: normalized.quantity,
        fillPriceCents: quote.priceCents,
        fillPriceCadCents: quote.priceCadCents,
        grossCents,
        status: "FILLED",
        createdAt: createdAt.toISOString(),
      };
      const receipt: TradeReceipt = {
        order,
        cashAfterCents,
        holdingQuantityAfter,
        portfolioVersion,
        duplicate: false,
      };

      await database`
        INSERT INTO public.idempotency_records (
          actor_user_id, idempotency_key, request_fingerprint, outcome_type,
          order_id, result_json, error_json, created_at
        ) VALUES (
          ${normalized.actorUserId}, ${normalized.idempotencyKey},
          ${normalized.fingerprint}, 'FILLED', ${orderId},
          ${JSON.stringify(receipt)}, NULL, ${createdAt}
        )
      `;
      await assertTeamLedger(database, account.team_id);
      return { receipt };
    } catch (error) {
      if (!writesStarted && shouldPersistRejection(error)) {
        await database`
          INSERT INTO public.idempotency_records (
            actor_user_id, idempotency_key, request_fingerprint, outcome_type,
            order_id, result_json, error_json, created_at
          ) VALUES (
            ${normalized.actorUserId}, ${normalized.idempotencyKey},
            ${normalized.fingerprint}, 'REJECTED', NULL, NULL,
            ${JSON.stringify(error.toJSON())}, ${new Date()}
          )
          ON CONFLICT (actor_user_id, idempotency_key) DO NOTHING
        `;
        return { rejection: error };
      }
      throw error;
    }
  });

  if (result.rejection) throw result.rejection;
  if (!result.receipt) {
    throw new AppError(
      "ORDER_RESULT_MISSING",
      "The order transaction completed without a receipt.",
      500,
    );
  }
  return result.receipt;
}
