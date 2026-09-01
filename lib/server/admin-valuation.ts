import { randomUUID } from "node:crypto";

import type {
  AdminValuationPortfolio,
  AdminValuationPosition,
  CreateAdminValuationPositionInput,
  SetAdminValuationCashInput,
} from "../backtest-contracts";
import type { MarketDataSource } from "../contracts";
import { AppError } from "../errors";
import { MARKET_REFRESH_INTERVAL_MS } from "../market-config";
import { getSessionUser } from "./auth";
import type { DbExecutor } from "./database";
import { getDb } from "./db";
import {
  getHistoricalMarketPrice,
  getHistoricalSplitMultipliers,
  normalizeMarketSymbol,
  refreshQuote,
} from "./quotes";

const MAX_POSITION_QUANTITY = 100_000;
const MAX_POSITIONS_PER_ADMIN = 50;
export const MAX_ADMIN_VALUATION_CASH_CENTS = 100_000_000_000_000;
const SPLIT_MULTIPLIER_SCALE = 1_000_000;
const SPLIT_REFRESH_INTERVAL_MS = 15 * 60_000;
const SPLIT_REFRESH_CONCURRENCY = 4;

interface PositionRow {
  id: string;
  admin_user_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  symbol: string;
  name: string;
  exchange: string;
  listing_currency: "CAD" | "USD";
  requested_date: string;
  session_date: string;
  session_at: string;
  quantity: number;
  fill_price_cents: number;
  fill_price_cad_cents: number;
  historical_fx_rate_basis_points: number;
  split_multiplier_ppm: number;
  split_checked_at: string;
  source: MarketDataSource;
  source_url: string | null;
  created_at: string;
}

interface ExistingPositionRow {
  request_fingerprint: string;
}

interface ValuationAccountRow {
  starting_cash_cents: number;
  version: number;
}

interface NormalizedPositionInput {
  actorUserId: string;
  idempotencyKey: string;
  symbol: string;
  quantity: number;
  purchaseDate: string;
  fingerprint: string;
}

function roundPercent(numerator: number, denominator: number): number {
  return denominator === 0
    ? 0
    : Math.round((numerator / denominator) * 10_000) / 100;
}

async function requirePlatformAdminActor(actorUserId: string): Promise<void> {
  const user = await getSessionUser(actorUserId);
  if (!user) {
    throw new AppError("UNAUTHORIZED", "Sign in to continue.", 401);
  }
  if (user.status !== "active") {
    throw new AppError("ACCOUNT_SUSPENDED", "This account is suspended.", 403);
  }
  if (user.role !== "platform_admin") {
    throw new AppError(
      "ADMIN_ONLY",
      "The Past → Present Lab is restricted to platform administrators.",
      403,
    );
  }
}

function normalizeValuationCash(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0 ||
    Number(value) > MAX_ADMIN_VALUATION_CASH_CENTS
  ) {
    throw new AppError(
      "INVALID_VALUATION_CASH",
      "Test-account cash must be a non-negative amount within the supported CAD limit.",
      400,
      {
        field: "cashCents",
        maximumCents: MAX_ADMIN_VALUATION_CASH_CENTS,
      },
    );
  }
  return Number(value);
}

function normalizePositionInput(
  input: CreateAdminValuationPositionInput,
): NormalizedPositionInput {
  const actorUserId = input.actorUserId?.trim();
  const idempotencyKey = input.idempotencyKey?.trim();
  const symbol = normalizeMarketSymbol(input.symbol ?? "");
  const purchaseDate = input.purchaseDate?.trim();

  if (!actorUserId) {
    throw new AppError("UNAUTHORIZED", "Sign in to continue.", 401);
  }
  if (!idempotencyKey || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey)) {
    throw new AppError(
      "INVALID_IDEMPOTENCY_KEY",
      "An idempotency key between 8 and 128 safe characters is required.",
      400,
    );
  }
  if (!/^[A-Z0-9.-]{1,16}$/.test(symbol)) {
    throw new AppError(
      "INVALID_SYMBOL",
      "Enter a valid NYSE, Nasdaq, or TSX ticker.",
      400,
      { field: "symbol" },
    );
  }
  if (
    !Number.isSafeInteger(input.quantity) ||
    input.quantity < 1 ||
    input.quantity > MAX_POSITION_QUANTITY
  ) {
    throw new AppError(
      "INVALID_QUANTITY",
      `Quantity must be a whole number from 1 to ${MAX_POSITION_QUANTITY.toLocaleString("en-CA")}.`,
      400,
      { field: "quantity" },
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) {
    throw new AppError(
      "INVALID_HISTORICAL_DATE",
      "Purchase date must use YYYY-MM-DD.",
      400,
      { field: "purchaseDate" },
    );
  }

  return {
    actorUserId,
    idempotencyKey,
    symbol,
    quantity: input.quantity,
    purchaseDate,
    fingerprint: `${actorUserId}|${symbol}|${input.quantity}|${purchaseDate}`,
  };
}

async function readPositionRows(
  actorUserId: string,
  executor?: DbExecutor,
): Promise<PositionRow[]> {
  const db = executor ?? (await getDb());
  return db.all<PositionRow>(
    `
      SELECT
        p.id, p.admin_user_id, p.idempotency_key, p.request_fingerprint,
        p.symbol, i.name, i.exchange, i.listing_currency,
        p.requested_date, p.session_date, p.session_at, p.quantity,
        p.fill_price_cents, p.fill_price_cad_cents,
        p.historical_fx_rate_basis_points, p.split_multiplier_ppm,
        p.split_checked_at,
        p.source, p.source_url, p.created_at
      FROM admin_valuation_positions AS p
      JOIN instruments AS i ON i.symbol = p.symbol
      WHERE p.admin_user_id = ?
      ORDER BY p.created_at DESC, p.id DESC
    `,
    [actorUserId],
  );
}

async function readValuationStartingCash(
  actorUserId: string,
  executor?: DbExecutor,
): Promise<number> {
  const db = executor ?? (await getDb());
  const account = await db.get<ValuationAccountRow>(
    `SELECT starting_cash_cents, version
     FROM admin_valuation_accounts
     WHERE admin_user_id = ?`,
    [actorUserId],
  );
  return account ? Number(account.starting_cash_cents) : 0;
}

async function readInvestedCost(
  executor: DbExecutor,
  actorUserId: string,
): Promise<number> {
  const row = await executor.get<{ cost_basis_cents: number }>(
    `SELECT COALESCE(SUM(fill_price_cad_cents * quantity), 0) AS cost_basis_cents
     FROM admin_valuation_positions
     WHERE admin_user_id = ?`,
    [actorUserId],
  );
  return assertSafeMoney(Number(row?.cost_basis_cents ?? 0));
}

/**
 * Ensures there is one row to lock before cash or positions mutate. The row
 * lock serializes funding, purchases, and clears for this administrator on
 * PostgreSQL; SQLite's write transaction already provides that guarantee.
 */
async function lockValuationAccount(
  executor: DbExecutor,
  actorUserId: string,
  updatedAt: string,
): Promise<ValuationAccountRow> {
  await executor.run(
    `INSERT INTO admin_valuation_accounts (
       admin_user_id, starting_cash_cents, version, updated_at
     ) VALUES (?, 0, 0, ?)
     ON CONFLICT (admin_user_id) DO NOTHING`,
    [actorUserId, updatedAt],
  );

  const account = await executor.get<ValuationAccountRow>(
    `SELECT starting_cash_cents, version
     FROM admin_valuation_accounts
     WHERE admin_user_id = ?${executor.engine === "postgres" ? " FOR UPDATE" : ""}`,
    [actorUserId],
  );
  if (!account) {
    throw new AppError(
      "VALUATION_ACCOUNT_UNAVAILABLE",
      "The test cash account could not be opened.",
      500,
    );
  }
  return {
    starting_cash_cents: Number(account.starting_cash_cents),
    version: Number(account.version),
  };
}

async function refreshSplitMultipliers(
  rows: PositionRow[],
  at: Date,
): Promise<Map<string, number>> {
  const dueRows = rows.filter((row) => {
    const checkedAt = new Date(row.split_checked_at);
    return (
      Number.isNaN(checkedAt.getTime()) ||
      at.getTime() - checkedAt.getTime() >= SPLIT_REFRESH_INTERVAL_MS
    );
  });
  if (dueRows.length === 0) {
    return new Map(
      rows.map((row) => [row.id, Number(row.split_multiplier_ppm)]),
    );
  }

  const rowsBySymbol = new Map<string, PositionRow[]>();
  for (const row of dueRows) {
    rowsBySymbol.set(row.symbol, [
      ...(rowsBySymbol.get(row.symbol) ?? []),
      row,
    ]);
  }
  const groups = [...rowsBySymbol.entries()];
  const refreshed: Array<{ id: string; splitMultiplierPpm: number }> = [];

  // One Yahoo corporate-action request serves every purchase date for a
  // symbol. Small batches prevent a full 50-position lab from creating a
  // burst that trips the free provider's rate limiter.
  for (let index = 0; index < groups.length; index += SPLIT_REFRESH_CONCURRENCY) {
    const batch = groups.slice(index, index + SPLIT_REFRESH_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async ([symbol, symbolRows]) => {
        const multipliers = await getHistoricalSplitMultipliers(
          symbol,
          symbolRows.map((row) => row.session_date),
          at,
        );
        return symbolRows.map((row) => {
          const multiplier = multipliers.get(row.session_date);
          if (
            typeof multiplier !== "number" ||
            !Number.isFinite(multiplier) ||
            multiplier <= 0
          ) {
            throw new AppError(
              "MARKET_DATA_INVALID",
              `The corporate-action history for ${symbol} was incomplete.`,
              503,
            );
          }
          return {
            id: row.id,
            splitMultiplierPpm: Math.max(
              1,
              Math.round(multiplier * SPLIT_MULTIPLIER_SCALE),
            ),
          };
        });
      }),
    );
    refreshed.push(...batchResults.flat());
  }
  const database = await getDb();
  const checkedAt = at.toISOString();

  await database.transaction(async (tx) => {
    for (const item of refreshed) {
      await tx.run(
        `
          UPDATE admin_valuation_positions
          SET split_multiplier_ppm = ?, split_checked_at = ?
          WHERE id = ?
        `,
        [item.splitMultiplierPpm, checkedAt, item.id],
      );
    }
  });

  const values = new Map(
    rows.map((row) => [row.id, Number(row.split_multiplier_ppm)]),
  );
  for (const item of refreshed) {
    values.set(item.id, item.splitMultiplierPpm);
  }
  return values;
}

function assertSafeMoney(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError(
      "VALUATION_TOO_LARGE",
      "This test position is too large to value safely.",
      400,
    );
  }
  return value;
}

export async function getAdminValuationPortfolio(
  actorUserId: string,
  at: Date = new Date(),
): Promise<AdminValuationPortfolio> {
  await requirePlatformAdminActor(actorUserId);
  const database = await getDb();
  const { rows, startingCashCents } = await database.readTransaction(
    async (tx) => {
      const [positionRows, configuredCash] = await Promise.all([
        readPositionRows(actorUserId, tx),
        readValuationStartingCash(actorUserId, tx),
      ]);
      return { rows: positionRows, startingCashCents: configuredCash };
    },
  );
  const symbols = [...new Set(rows.map((row) => row.symbol))];
  const [refreshedQuotes, splitMultipliers] = await Promise.all([
    Promise.all(
      symbols.map(async (symbol) => {
        const quote = await refreshQuote(symbol, at);
        if (!quote) {
          throw new AppError(
            "UNKNOWN_SYMBOL",
            `No current quote is available for ${symbol}.`,
            404,
            { symbol },
          );
        }
        return quote;
      }),
    ),
    refreshSplitMultipliers(rows, at),
  ]);
  const quotesBySymbol = new Map(
    refreshedQuotes.map((quote) => [quote.symbol, quote]),
  );

  const positions = rows.map((row): AdminValuationPosition => {
    const quote = quotesBySymbol.get(row.symbol);
    if (!quote) {
      throw new AppError(
        "QUOTE_UNAVAILABLE",
        `No current quote is available for ${row.symbol}.`,
        503,
      );
    }
    const originalQuantity = Number(row.quantity);
    const splitMultiplier =
      (splitMultipliers.get(row.id) ?? Number(row.split_multiplier_ppm)) /
      SPLIT_MULTIPLIER_SCALE;
    const currentQuantity = originalQuantity * splitMultiplier;
    const costBasisCents = assertSafeMoney(
      Number(row.fill_price_cad_cents) * originalQuantity,
    );
    const currentValueCents = assertSafeMoney(
      Math.round(quote.priceCadCents * currentQuantity),
    );
    const gainLossCents = currentValueCents - costBasisCents;

    return {
      id: row.id,
      symbol: row.symbol,
      name: row.name,
      exchange: row.exchange,
      listingCurrency: row.listing_currency,
      requestedDate: row.requested_date,
      sessionDate: row.session_date,
      sessionAt: row.session_at,
      originalQuantity,
      currentQuantity,
      splitMultiplier,
      purchasePriceCents: Number(row.fill_price_cents),
      purchasePriceCadCents: Number(row.fill_price_cad_cents),
      historicalFxRateBasisPoints: Number(
        row.historical_fx_rate_basis_points,
      ),
      costBasisCents,
      currentPriceCents: quote.priceCents,
      currentPriceCadCents: quote.priceCadCents,
      currentValueCents,
      gainLossCents,
      returnPercent: roundPercent(gainLossCents, costBasisCents),
      currentQuoteAsOf: quote.asOf,
      currentQuoteIsStale: quote.isStale,
      source: row.source,
      sourceUrl: row.source_url,
      createdAt: row.created_at,
    };
  });

  const costBasisCents = assertSafeMoney(
    positions.reduce(
      (total, position) => total + position.costBasisCents,
      0,
    ),
  );
  const holdingsValueCents = assertSafeMoney(
    positions.reduce(
      (total, position) => total + position.currentValueCents,
      0,
    ),
  );
  const availableCashCents = startingCashCents - costBasisCents;
  if (!Number.isSafeInteger(availableCashCents) || availableCashCents < 0) {
    throw new AppError(
      "VALUATION_ACCOUNT_OUT_OF_BALANCE",
      "The test account's purchases exceed its configured cash.",
      500,
      { startingCashCents, costBasisCents },
    );
  }
  const totalValueCents = assertSafeMoney(
    availableCashCents + holdingsValueCents,
  );
  const gainLossCents = holdingsValueCents - costBasisCents;

  return {
    summary: {
      positionCount: positions.length,
      startingCashCents,
      availableCashCents,
      costBasisCents,
      holdingsValueCents,
      totalValueCents,
      currentValueCents: holdingsValueCents,
      gainLossCents,
      returnPercent: roundPercent(gainLossCents, costBasisCents),
      asOf: at.toISOString(),
      hasStaleQuotes: positions.some((position) => position.currentQuoteIsStale),
    },
    positions,
    refreshIntervalSeconds: Math.round(MARKET_REFRESH_INTERVAL_MS / 1_000),
  };
}

export async function setAdminValuationCash(
  input: SetAdminValuationCashInput,
  at: Date = new Date(),
): Promise<AdminValuationPortfolio> {
  await requirePlatformAdminActor(input.actorUserId);
  const cashCents = normalizeValuationCash(input.cashCents);
  const database = await getDb();
  const updatedAt = at.toISOString();

  await database.transaction(async (tx) => {
    const account = await lockValuationAccount(tx, input.actorUserId, updatedAt);
    const investedCents = await readInvestedCost(tx, input.actorUserId);
    if (cashCents < investedCents) {
      throw new AppError(
        "VALUATION_CASH_BELOW_INVESTED",
        "Test-account cash cannot be lower than the historical purchases already recorded.",
        409,
        {
          field: "cashCents",
          investedCents,
          minimumCents: investedCents,
        },
      );
    }
    if (Number(account.starting_cash_cents) === cashCents) {
      return;
    }

    const changed = await tx.run(
      `UPDATE admin_valuation_accounts
       SET starting_cash_cents = ?, version = version + 1, updated_at = ?
       WHERE admin_user_id = ? AND version = ?`,
      [cashCents, updatedAt, input.actorUserId, account.version],
    );
    if (changed.changes !== 1) {
      throw new AppError(
        "VALUATION_ACCOUNT_CONFLICT",
        "The test account changed while its cash was being updated.",
        409,
      );
    }
  });

  return getAdminValuationPortfolio(input.actorUserId, at);
}

export async function createAdminValuationPosition(
  input: CreateAdminValuationPositionInput,
  at: Date = new Date(),
): Promise<AdminValuationPortfolio> {
  await requirePlatformAdminActor(input.actorUserId);
  const normalized = normalizePositionInput(input);
  const database = await getDb();
  const existing = await database.get<ExistingPositionRow>(
    `
      SELECT request_fingerprint
      FROM admin_valuation_positions
      WHERE admin_user_id = ? AND idempotency_key = ?
    `,
    [normalized.actorUserId, normalized.idempotencyKey],
  );
  if (existing) {
    if (existing.request_fingerprint !== normalized.fingerprint) {
      throw new AppError(
        "IDEMPOTENCY_CONFLICT",
        "That idempotency key was already used for another test purchase.",
        409,
      );
    }
    return getAdminValuationPortfolio(normalized.actorUserId, at);
  }

  const currentQuote = await refreshQuote(normalized.symbol, at);
  if (!currentQuote) {
    throw new AppError(
      "UNKNOWN_SYMBOL",
      `No supported NYSE, Nasdaq, or TSX quote was found for ${normalized.symbol}.`,
      404,
      { field: "symbol", symbol: normalized.symbol },
    );
  }
  const historical = await getHistoricalMarketPrice(
    normalized.symbol,
    normalized.purchaseDate,
    at,
  );
  const grossCents = historical.closeCadCents * normalized.quantity;
  assertSafeMoney(grossCents);

  await database.transaction(async (tx) => {
    const account = await lockValuationAccount(
      tx,
      normalized.actorUserId,
      at.toISOString(),
    );
    const replay = await tx.get<ExistingPositionRow>(
      `
        SELECT request_fingerprint
        FROM admin_valuation_positions
        WHERE admin_user_id = ? AND idempotency_key = ?
      `,
      [normalized.actorUserId, normalized.idempotencyKey],
    );
    if (replay) {
      if (replay.request_fingerprint !== normalized.fingerprint) {
        throw new AppError(
          "IDEMPOTENCY_CONFLICT",
          "That idempotency key was already used for another test purchase.",
          409,
        );
      }
      // Replayed request: commit without inserting and fall through to the
      // portfolio read below.
      return;
    }

    const count = await tx.get<{ count: number }>(
      `
        SELECT COUNT(*) AS count
        FROM admin_valuation_positions
        WHERE admin_user_id = ?
      `,
      [normalized.actorUserId],
    );
    if (Number(count?.count ?? 0) >= MAX_POSITIONS_PER_ADMIN) {
      throw new AppError(
        "VALUATION_POSITION_LIMIT",
        `The test lab supports up to ${MAX_POSITIONS_PER_ADMIN} purchases. Clear it before adding more.`,
        409,
      );
    }

    const investedCents = await readInvestedCost(tx, normalized.actorUserId);
    const availableCashCents =
      Number(account.starting_cash_cents) - investedCents;
    if (availableCashCents < grossCents) {
      throw new AppError(
        "INSUFFICIENT_VALUATION_CASH",
        "Fund the test account before adding this historical purchase.",
        409,
        {
          availableCashCents,
          requiredCashCents: grossCents,
          shortfallCents: grossCents - Math.max(0, availableCashCents),
        },
      );
    }

    await tx.run(
      `
        INSERT INTO admin_valuation_positions (
          id, admin_user_id, idempotency_key, request_fingerprint,
          symbol, requested_date, session_date, session_at, quantity,
          fill_price_cents, fill_price_cad_cents,
          historical_fx_rate_basis_points, split_multiplier_ppm,
          split_checked_at, source, source_url, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        randomUUID(),
        normalized.actorUserId,
        normalized.idempotencyKey,
        normalized.fingerprint,
        historical.symbol,
        historical.requestedDate,
        historical.sessionDate,
        historical.sessionAt,
        normalized.quantity,
        historical.closeCents,
        historical.closeCadCents,
        historical.fxRateBasisPoints,
        Math.max(
          1,
          Math.round(historical.splitMultiplier * SPLIT_MULTIPLIER_SCALE),
        ),
        at.toISOString(),
        historical.source,
        historical.sourceUrl,
        at.toISOString(),
      ],
    );

    const changed = await tx.run(
      `UPDATE admin_valuation_accounts
       SET version = version + 1, updated_at = ?
       WHERE admin_user_id = ? AND version = ?`,
      [at.toISOString(), normalized.actorUserId, account.version],
    );
    if (changed.changes !== 1) {
      throw new AppError(
        "VALUATION_ACCOUNT_CONFLICT",
        "The test account changed while the purchase was being recorded.",
        409,
      );
    }
  });

  return getAdminValuationPortfolio(normalized.actorUserId, at);
}

export async function clearAdminValuationPortfolio(
  actorUserId: string,
  at: Date = new Date(),
): Promise<AdminValuationPortfolio> {
  await requirePlatformAdminActor(actorUserId);
  const db = await getDb();
  await db.transaction(async (tx) => {
    const account = await lockValuationAccount(tx, actorUserId, at.toISOString());
    const removed = await tx.run(
      "DELETE FROM admin_valuation_positions WHERE admin_user_id = ?",
      [actorUserId],
    );
    if (removed.changes === 0) {
      return;
    }

    const changed = await tx.run(
      `UPDATE admin_valuation_accounts
       SET version = version + 1, updated_at = ?
       WHERE admin_user_id = ? AND version = ?`,
      [at.toISOString(), actorUserId, account.version],
    );
    if (changed.changes !== 1) {
      throw new AppError(
        "VALUATION_ACCOUNT_CONFLICT",
        "The test account changed while its positions were being cleared.",
        409,
      );
    }
  });
  return getAdminValuationPortfolio(actorUserId, at);
}
