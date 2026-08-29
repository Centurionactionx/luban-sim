import type {
  InstrumentSearchResult,
  Quote,
  QuoteHistory,
  QuoteRange,
} from "../../contracts";
import { AppError } from "../../errors";
import {
  getMarketDataProvider,
  normalizeMarketSymbol,
  type MarketInstrument,
} from "../quotes";
import {
  getPostgresClient,
  type PostgresExecutor,
} from "./client";

interface InstrumentRow {
  symbol: string;
  name: string;
  exchange: string;
  sector: string;
  listing_currency: "CAD" | "USD";
  base_price_cents: string | number;
  previous_close_cents: string | number;
  fx_rate_basis_points: string | number;
}

function rowToInstrument(row: InstrumentRow): MarketInstrument {
  return {
    symbol: row.symbol,
    name: row.name,
    exchange: row.exchange,
    sector: row.sector,
    listingCurrency: row.listing_currency,
    basePriceCents: Number(row.base_price_cents),
    previousCloseCents: Number(row.previous_close_cents),
    fxRateBasisPoints: Number(row.fx_rate_basis_points),
  };
}

async function readInstrument(
  symbol: string,
  database: PostgresExecutor = getPostgresClient(),
): Promise<MarketInstrument | null> {
  const normalized = normalizeMarketSymbol(symbol);
  const rows = await database<InstrumentRow[]>`
    SELECT
      symbol, name, exchange, sector, listing_currency,
      base_price_cents, previous_close_cents, fx_rate_basis_points
    FROM public.instruments
    WHERE symbol = ${normalized} AND is_active = 1
    LIMIT 1
  `;

  return rows[0] ? rowToInstrument(rows[0]) : null;
}

async function readInstruments(
  database: PostgresExecutor = getPostgresClient(),
  refreshableOnly = false,
): Promise<MarketInstrument[]> {
  const rows = refreshableOnly
    ? await database<InstrumentRow[]>`
        SELECT
          i.symbol, i.name, i.exchange, i.sector, i.listing_currency,
          i.base_price_cents, i.previous_close_cents, i.fx_rate_basis_points
        FROM public.instruments AS i
        WHERE i.is_active = 1
          AND (
            i.auto_refresh = 1
            OR EXISTS (
              SELECT 1
              FROM public.holdings AS h
              WHERE h.symbol = i.symbol AND h.quantity > 0
            )
          )
        ORDER BY i.symbol ASC
      `
    : await database<InstrumentRow[]>`
        SELECT
          symbol, name, exchange, sector, listing_currency,
          base_price_cents, previous_close_cents, fx_rate_basis_points
        FROM public.instruments
        WHERE is_active = 1
        ORDER BY symbol ASC
      `;

  return rows.map(rowToInstrument);
}

async function resolveInstrument(
  symbol: string,
): Promise<InstrumentSearchResult | null> {
  const provider = getMarketDataProvider();
  if (provider.resolveInstrument) {
    return provider.resolveInstrument(symbol);
  }
  if (!provider.search) return null;
  const results = await provider.search(symbol);
  return results.find((result) => result.symbol === symbol) ?? null;
}

async function fetchQuote(
  instrument: MarketInstrument,
  at: Date,
): Promise<Quote> {
  const provider = getMarketDataProvider();
  return provider.refreshQuote
    ? provider.refreshQuote(instrument, at)
    : provider.quote(instrument, at);
}

function isMarketDataError(error: unknown): error is AppError {
  return error instanceof AppError && error.code.startsWith("MARKET_DATA_");
}

async function persistInstrument(
  result: InstrumentSearchResult,
  quote: Quote,
  database: PostgresExecutor = getPostgresClient(),
): Promise<void> {
  await database`
    INSERT INTO public.instruments (
      symbol, name, exchange, sector, listing_currency,
      base_price_cents, previous_close_cents, fx_rate_basis_points,
      is_active, auto_refresh
    ) VALUES (
      ${result.symbol}, ${result.name}, ${result.exchange}, ${result.sector},
      ${result.listingCurrency}, ${quote.priceCents},
      ${quote.previousCloseCents}, ${quote.fxRateBasisPoints}, 1, 0
    )
    ON CONFLICT (symbol) DO UPDATE SET
      name = EXCLUDED.name,
      exchange = EXCLUDED.exchange,
      sector = EXCLUDED.sector,
      listing_currency = EXCLUDED.listing_currency,
      base_price_cents = EXCLUDED.base_price_cents,
      previous_close_cents = EXCLUDED.previous_close_cents,
      fx_rate_basis_points = EXCLUDED.fx_rate_basis_points,
      is_active = 1
  `;
}

async function persistQuoteMetadata(
  instrument: MarketInstrument,
  quote: Quote,
  database: PostgresExecutor = getPostgresClient(),
): Promise<void> {
  await database`
    UPDATE public.instruments
    SET
      name = ${quote.name},
      exchange = ${quote.exchange},
      sector = ${quote.sector},
      listing_currency = ${quote.listingCurrency},
      base_price_cents = ${quote.priceCents},
      previous_close_cents = ${quote.previousCloseCents},
      fx_rate_basis_points = ${quote.fxRateBasisPoints}
    WHERE symbol = ${instrument.symbol}
  `;
}

export async function refreshPostgresQuote(
  symbol: string,
  at: Date = new Date(),
  database: PostgresExecutor = getPostgresClient(),
): Promise<Quote | null> {
  const normalized = normalizeMarketSymbol(symbol);
  let instrument = await readInstrument(normalized, database);

  if (!instrument) {
    const discovered = await resolveInstrument(normalized);
    if (!discovered) return null;

    instrument = {
      ...discovered,
      basePriceCents: 1,
      previousCloseCents: 1,
      fxRateBasisPoints: discovered.listingCurrency === "CAD" ? 10_000 : 13_600,
    };
    const quote = await fetchQuote(instrument, at);
    await persistInstrument(discovered, quote, database);
    return quote;
  }

  const quote = await fetchQuote(instrument, at);
  await persistQuoteMetadata(instrument, quote, database);
  return quote;
}

export async function refreshAllPostgresQuotes(
  at: Date = new Date(),
): Promise<void> {
  const database = getPostgresClient();
  const instruments = await readInstruments(database, true);
  let successfulRefreshes = 0;
  const marketFailures: unknown[] = [];

  // The provider coalesces/cache-hits requests for one minute. Batching keeps
  // the free upstream feed responsive without opening an unbounded fan-out.
  for (let offset = 0; offset < instruments.length; offset += 5) {
    const batch = instruments.slice(offset, offset + 5);
    const outcomes = await Promise.allSettled(
      batch.map(async (instrument) => {
        const quote = await fetchQuote(instrument, at);
        await persistQuoteMetadata(instrument, quote, database);
      }),
    );
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled") {
        successfulRefreshes += 1;
      } else if (isMarketDataError(outcome.reason)) {
        marketFailures.push(outcome.reason);
      } else {
        // Database/configuration failures must never be hidden behind a
        // partially successful market refresh.
        throw outcome.reason;
      }
    }
  }

  if (
    instruments.length > 0 &&
    successfulRefreshes === 0 &&
    marketFailures.length > 0
  ) {
    throw marketFailures[0];
  }
}

export async function listPostgresQuotes(
  at: Date = new Date(),
): Promise<Quote[]> {
  const instruments = await readInstruments();
  const provider = getMarketDataProvider();
  const quotes: Quote[] = [];
  for (const instrument of instruments) {
    try {
      quotes.push(provider.quote(instrument, at));
    } catch (error) {
      // Discovered, unheld instruments are intentionally not warmed on every
      // cold start. Omit only cache/market misses; surface programming or DB
      // failures normally.
      if (!isMarketDataError(error)) throw error;
    }
  }
  return quotes;
}

export async function searchPostgresInstruments(
  query: string,
): Promise<InstrumentSearchResult[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];

  const database = getPostgresClient();
  const pattern = `%${normalizedQuery}%`;
  const localRows = await database<InstrumentRow[]>`
    SELECT
      symbol, name, exchange, sector, listing_currency,
      base_price_cents, previous_close_cents, fx_rate_basis_points
    FROM public.instruments
    WHERE is_active = 1
      AND (
        symbol ILIKE ${pattern}
        OR name ILIKE ${pattern}
        OR exchange ILIKE ${pattern}
        OR sector ILIKE ${pattern}
      )
    ORDER BY symbol ASC
    LIMIT 25
  `;
  const local = localRows.map((row) => {
    const instrument = rowToInstrument(row);
    return {
      symbol: instrument.symbol,
      name: instrument.name,
      exchange: instrument.exchange,
      sector: instrument.sector,
      listingCurrency: instrument.listingCurrency,
    } satisfies InstrumentSearchResult;
  });

  const provider = getMarketDataProvider();
  if (!provider.search) return local;

  const remote = await provider.search(normalizedQuery);
  const combined = new Map<string, InstrumentSearchResult>();
  for (const result of [...remote, ...local]) {
    combined.set(result.symbol, result);
  }
  return [...combined.values()].slice(0, 25);
}

export async function getPostgresQuoteHistory(
  symbol: string,
  range: QuoteRange,
  at: Date = new Date(),
): Promise<QuoteHistory> {
  const instrument = await readInstrument(symbol);
  if (!instrument) {
    throw new AppError(
      "UNKNOWN_SYMBOL",
      `The symbol ${normalizeMarketSymbol(symbol)} is not available in this simulation.`,
      404,
    );
  }

  const provider = getMarketDataProvider();
  if (!provider.history) {
    throw new AppError(
      "QUOTE_HISTORY_UNAVAILABLE",
      "Historical market data is unavailable from the configured provider.",
      503,
    );
  }
  return provider.history(instrument, range, at);
}

export async function ensurePostgresInstrumentForQuote(
  quote: Quote,
  database: PostgresExecutor,
): Promise<void> {
  const result: InstrumentSearchResult = {
    symbol: quote.symbol,
    name: quote.name,
    exchange: quote.exchange,
    sector: quote.sector,
    listingCurrency: quote.listingCurrency,
  };
  await persistInstrument(result, quote, database);
}
