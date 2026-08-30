import { randomUUID } from "node:crypto";

import type {
  AdminValuationPortfolio,
  AdminValuationPosition,
  CreateAdminValuationPositionInput,
} from "../backtest-contracts";
import type { MarketDataSource } from "../contracts";
import { AppError } from "../errors";
import { MARKET_REFRESH_INTERVAL_MS } from "../market-config";
import { getSessionUser } from "./auth";
import { getDatabase } from "./db";
import {
  getHistoricalMarketPrice,
  getHistoricalSplitMultipliers,
  normalizeMarketSymbol,
  refreshQuote,
} from "./quotes";

const MAX_POSITION_QUANTITY = 100_000;
const MAX_POSITIONS_PER_ADMIN = 50;
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

function requirePlatformAdminActor(actorUserId: string): void {
  const user = getSessionUser(actorUserId);
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

function readPositionRows(actorUserId: string): PositionRow[] {
  return getDatabase()
    .prepare(`
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
    `)
    .all(actorUserId) as unknown as PositionRow[];
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
  const database = getDatabase();
  const checkedAt = at.toISOString();

  database.exec("BEGIN IMMEDIATE;");
  try {
    const update = database.prepare(`
      UPDATE admin_valuation_positions
      SET split_multiplier_ppm = ?, split_checked_at = ?
      WHERE id = ?
    `);
    for (const item of refreshed) {
      update.run(item.splitMultiplierPpm, checkedAt, item.id);
    }
    database.exec("COMMIT;");
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // Preserve the database error that initiated the rollback.
    }
    throw error;
  }

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
  requirePlatformAdminActor(actorUserId);
  const rows = readPositionRows(actorUserId);
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

  const costBasisCents = positions.reduce(
    (total, position) => total + position.costBasisCents,
    0,
  );
  const currentValueCents = positions.reduce(
    (total, position) => total + position.currentValueCents,
    0,
  );
  const gainLossCents = currentValueCents - costBasisCents;

  return {
    summary: {
      positionCount: positions.length,
      costBasisCents,
      currentValueCents,
      gainLossCents,
      returnPercent: roundPercent(gainLossCents, costBasisCents),
      asOf: at.toISOString(),
      hasStaleQuotes: positions.some((position) => position.currentQuoteIsStale),
    },
    positions,
    refreshIntervalSeconds: Math.round(MARKET_REFRESH_INTERVAL_MS / 1_000),
  };
}

export async function createAdminValuationPosition(
  input: CreateAdminValuationPositionInput,
  at: Date = new Date(),
): Promise<AdminValuationPortfolio> {
  requirePlatformAdminActor(input.actorUserId);
  const normalized = normalizePositionInput(input);
  const database = getDatabase();
  const existing = database
    .prepare(`
      SELECT request_fingerprint
      FROM admin_valuation_positions
      WHERE admin_user_id = ? AND idempotency_key = ?
    `)
    .get(normalized.actorUserId, normalized.idempotencyKey) as
    | ExistingPositionRow
    | undefined;
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

  database.exec("BEGIN IMMEDIATE;");
  let transactionOpen = true;
  try {
    const replay = database
      .prepare(`
        SELECT request_fingerprint
        FROM admin_valuation_positions
        WHERE admin_user_id = ? AND idempotency_key = ?
      `)
      .get(normalized.actorUserId, normalized.idempotencyKey) as
      | ExistingPositionRow
      | undefined;
    if (replay) {
      if (replay.request_fingerprint !== normalized.fingerprint) {
        throw new AppError(
          "IDEMPOTENCY_CONFLICT",
          "That idempotency key was already used for another test purchase.",
          409,
        );
      }
      database.exec("COMMIT;");
      transactionOpen = false;
      return getAdminValuationPortfolio(normalized.actorUserId, at);
    }

    const count = database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM admin_valuation_positions
        WHERE admin_user_id = ?
      `)
      .get(normalized.actorUserId) as { count: number };
    if (Number(count.count) >= MAX_POSITIONS_PER_ADMIN) {
      throw new AppError(
        "VALUATION_POSITION_LIMIT",
        `The test lab supports up to ${MAX_POSITIONS_PER_ADMIN} purchases. Clear it before adding more.`,
        409,
      );
    }

    database
      .prepare(`
        INSERT INTO admin_valuation_positions (
          id, admin_user_id, idempotency_key, request_fingerprint,
          symbol, requested_date, session_date, session_at, quantity,
          fill_price_cents, fill_price_cad_cents,
          historical_fx_rate_basis_points, split_multiplier_ppm,
          split_checked_at, source, source_url, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
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
      );
    database.exec("COMMIT;");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try {
        database.exec("ROLLBACK;");
      } catch {
        // Preserve the original domain or database error.
      }
    }
    throw error;
  }

  return getAdminValuationPortfolio(normalized.actorUserId, at);
}

export async function clearAdminValuationPortfolio(
  actorUserId: string,
  at: Date = new Date(),
): Promise<AdminValuationPortfolio> {
  requirePlatformAdminActor(actorUserId);
  getDatabase()
    .prepare("DELETE FROM admin_valuation_positions WHERE admin_user_id = ?")
    .run(actorUserId);
  return getAdminValuationPortfolio(actorUserId, at);
}
