import type {
  ActivityItem,
  CompetitionStatus,
  CompetitionSummary,
  Dashboard,
  HoldingView,
  Leaderboard,
  LeaderboardRow,
  OrderStatus,
  OrderView,
  PortfolioPoint,
  PortfolioSummary,
  Quote,
  SessionUser,
  TeamStatus,
  TeamSummary,
  TradeSide,
  UserRole,
} from "../../contracts";
import { AppError } from "../../errors";
import {
  getMarketDataProvider,
  type MarketInstrument,
} from "../quotes";
import {
  getPostgresClient,
  type PostgresExecutor,
} from "./client";

type DatabaseInteger = bigint | number | string;
type DatabaseTimestamp = Date | string;

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  team_id: string | null;
  team_name: string | null;
}

interface CompetitionRow {
  id: string;
  name: string;
  status: CompetitionStatus;
  base_currency: "CAD";
  starting_cash_cents: DatabaseInteger;
  starts_at: DatabaseTimestamp;
  ends_at: DatabaseTimestamp;
}

interface TeamRow {
  id: string;
  name: string;
  status: TeamStatus;
  cash_cents: DatabaseInteger;
  version: DatabaseInteger;
}

interface LeaderboardTeamRow extends TeamRow {
  trade_count: DatabaseInteger;
}

interface HoldingRow {
  symbol: string;
  quantity: DatabaseInteger;
  average_cost_cents: DatabaseInteger;
  name: string;
  exchange: string;
  sector: string;
  listing_currency: "CAD" | "USD";
  base_price_cents: DatabaseInteger;
  previous_close_cents: DatabaseInteger;
  fx_rate_basis_points: DatabaseInteger;
}

interface InstrumentRow {
  symbol: string;
  name: string;
  exchange: string;
  sector: string;
  listing_currency: "CAD" | "USD";
  base_price_cents: DatabaseInteger;
  previous_close_cents: DatabaseInteger;
  fx_rate_basis_points: DatabaseInteger;
  auto_refresh: DatabaseInteger;
}

interface OrderRow {
  id: string;
  idempotency_key: string;
  team_id: string;
  team_name: string;
  actor_user_id: string;
  actor_name: string;
  symbol: string;
  side: TradeSide;
  quantity: DatabaseInteger;
  fill_price_cents: DatabaseInteger;
  fill_price_cad_cents: DatabaseInteger;
  gross_cents: DatabaseInteger;
  status: OrderStatus;
  created_at: DatabaseTimestamp;
}

interface ActivityRow {
  id: string;
  type: ActivityItem["type"];
  title: string;
  detail: string;
  actor_user_id: string | null;
  actor_name: string | null;
  team_id: string | null;
  team_name: string | null;
  created_at: DatabaseTimestamp;
}

interface SnapshotRow {
  total_value_cents: DatabaseInteger;
  captured_at: DatabaseTimestamp;
}

export interface PortfolioCalculation {
  summary: PortfolioSummary;
  holdings: HoldingView[];
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
      500,
    );
  }
  return Number(value);
}

function safeAdd(left: number, right: number, field: string): number {
  return safeIntegerFromBigInt(BigInt(left) + BigInt(right), field);
}

function safeSubtract(left: number, right: number, field: string): number {
  return safeIntegerFromBigInt(BigInt(left) - BigInt(right), field);
}

function safeMultiply(left: number, right: number, field: string): number {
  return safeIntegerFromBigInt(BigInt(left) * BigInt(right), field);
}

function isoTimestamp(value: DatabaseTimestamp, field: string): string {
  const parsed = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(
      "DATABASE_TIMESTAMP_INVALID",
      `The stored ${field} timestamp is invalid.`,
      500,
    );
  }

  return parsed.toISOString();
}

function initialsFor(name: string): string {
  return name
    .replace(/\([^)]*\)/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function rowToSessionUser(row: UserRow): SessionUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    teamId: row.team_id,
    teamName: row.team_name,
    initials: initialsFor(row.name),
  };
}

function rowToInstrument(row: HoldingRow | InstrumentRow): MarketInstrument {
  return {
    symbol: row.symbol,
    name: row.name,
    exchange: row.exchange,
    sector: row.sector,
    listingCurrency: row.listing_currency,
    basePriceCents: databaseInteger(row.base_price_cents, "base price"),
    previousCloseCents: databaseInteger(
      row.previous_close_cents,
      "previous close",
    ),
    fxRateBasisPoints: databaseInteger(
      row.fx_rate_basis_points,
      "FX rate",
    ),
  };
}

function roundPercent(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

function normalizedLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined) return fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new AppError("INVALID_LIMIT", "Limit must be a positive integer.", 400);
  }
  return Math.min(limit, 100);
}

function isRecoverableQuoteError(error: unknown): boolean {
  return (
    error instanceof AppError &&
    ["MARKET_DATA_UNAVAILABLE", "MARKET_DATA_TIMEOUT"].includes(error.code)
  );
}

function storedFallbackQuote(
  instrument: MarketInstrument,
  at: Date,
): Quote {
  const priceCadCents = safeIntegerFromBigInt(
    (BigInt(instrument.basePriceCents) *
      BigInt(instrument.fxRateBasisPoints) +
      BigInt(5_000)) /
      BigInt(10_000),
    "stored CAD quote price",
  );
  const previousCloseCadCents = safeIntegerFromBigInt(
    (BigInt(instrument.previousCloseCents) *
      BigInt(instrument.fxRateBasisPoints) +
      BigInt(5_000)) /
      BigInt(10_000),
    "stored previous CAD close",
  );
  const changeCents = safeSubtract(
    instrument.basePriceCents,
    instrument.previousCloseCents,
    "stored quote change",
  );

  return {
    symbol: instrument.symbol,
    name: instrument.name,
    exchange: instrument.exchange,
    sector: instrument.sector,
    listingCurrency: instrument.listingCurrency,
    priceCents: instrument.basePriceCents,
    priceCadCents,
    previousCloseCents: instrument.previousCloseCents,
    previousCloseCadCents,
    changeCents,
    changePercent: roundPercent(changeCents, instrument.previousCloseCents),
    fxRateBasisPoints: instrument.fxRateBasisPoints,
    asOf: at.toISOString(),
    source: "YAHOO_FINANCE",
    sourceUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(instrument.symbol)}`,
    isStale: true,
  };
}

/**
 * Reads or refreshes a quote through the existing provider/cache seam without
 * consulting the SQLite-backed instrument registry.
 */
export async function quoteForInstrument(
  instrument: MarketInstrument,
  at: Date = new Date(),
  refresh = true,
  allowStoredFallback = false,
): Promise<Quote | null> {
  const provider = getMarketDataProvider();

  try {
    if (refresh && provider.refreshQuote) {
      return await provider.refreshQuote(instrument, at);
    }
    return provider.quote(instrument, at);
  } catch (error) {
    if (
      allowStoredFallback &&
      error instanceof AppError &&
      error.code.startsWith("MARKET_DATA_")
    ) {
      return storedFallbackQuote(instrument, at);
    }
    if (isRecoverableQuoteError(error)) return null;
    throw error;
  }
}

async function refreshInstrumentQuotes(
  instruments: readonly MarketInstrument[],
  at: Date,
): Promise<void> {
  const provider = getMarketDataProvider();

  await Promise.allSettled(
    instruments.map((instrument) =>
      provider.refreshQuote
        ? provider.refreshQuote(instrument, at)
        : Promise.resolve(provider.quote(instrument, at)),
    ),
  );
}

function cachedQuoteForInstrument(
  instrument: MarketInstrument,
  at: Date,
): Quote | null {
  try {
    return getMarketDataProvider().quote(instrument, at);
  } catch (error) {
    if (error instanceof AppError && error.code.startsWith("MARKET_DATA_")) {
      return null;
    }
    throw error;
  }
}

export async function requirePostgresSessionUser(
  userId: string,
  executor: PostgresExecutor = getPostgresClient(),
): Promise<SessionUser> {
  const rows = await executor<UserRow[]>`
    SELECT
      u.id,
      u.name,
      u.email,
      u.role,
      tm.team_id,
      t.name AS team_name
    FROM public.users AS u
    LEFT JOIN public.team_members AS tm ON tm.user_id = u.id
    LEFT JOIN public.teams AS t ON t.id = tm.team_id
    WHERE u.id = ${userId}
    LIMIT 1
  `;
  const row = rows[0];

  if (!row) {
    throw new AppError("UNAUTHORIZED", "Sign in to continue.", 401);
  }

  return rowToSessionUser(row);
}

export async function getPostgresCompetitionSummary(
  executor: PostgresExecutor = getPostgresClient(),
): Promise<CompetitionSummary> {
  const rows = await executor<CompetitionRow[]>`
    SELECT
      id,
      name,
      status,
      base_currency,
      starting_cash_cents,
      starts_at,
      ends_at
    FROM public.competitions
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const row = rows[0];

  if (!row) {
    throw new AppError(
      "COMPETITION_NOT_FOUND",
      "No competition is configured.",
      404,
    );
  }

  return {
    id: row.id,
    name: row.name,
    status: row.status,
    baseCurrency: row.base_currency,
    startingCashCents: databaseInteger(
      row.starting_cash_cents,
      "starting cash",
    ),
    startsAt: isoTimestamp(row.starts_at, "competition start"),
    endsAt: isoTimestamp(row.ends_at, "competition end"),
  };
}

export async function getPostgresTeamSummary(
  teamId: string,
  executor: PostgresExecutor = getPostgresClient(),
): Promise<TeamSummary> {
  const teamRows = await executor<TeamRow[]>`
    SELECT id, name, status, cash_cents, version
    FROM public.teams
    WHERE id = ${teamId}
    LIMIT 1
  `;
  const team = teamRows[0];

  if (!team) {
    throw new AppError("TEAM_NOT_FOUND", "That team does not exist.", 404);
  }

  const members = await executor<Array<{ name: string }>>`
    SELECT u.name
    FROM public.team_members AS tm
    JOIN public.users AS u ON u.id = tm.user_id
    WHERE tm.team_id = ${teamId}
    ORDER BY tm.is_captain DESC, u.name ASC
  `;

  return {
    id: team.id,
    name: team.name,
    status: team.status,
    memberNames: members.map((member) => member.name),
    version: databaseInteger(team.version, "team version"),
  };
}

async function calculatePortfolioWithCompetition(
  teamId: string,
  at: Date,
  competition: CompetitionSummary,
  executor: PostgresExecutor,
  allowStoredQuoteFallback = false,
): Promise<PortfolioCalculation> {
  const teamRows = await executor<TeamRow[]>`
    SELECT id, name, status, cash_cents, version
    FROM public.teams
    WHERE id = ${teamId}
    LIMIT 1
  `;
  const team = teamRows[0];

  if (!team) {
    throw new AppError("TEAM_NOT_FOUND", "That team does not exist.", 404);
  }

  const holdingRows = await executor<HoldingRow[]>`
    SELECT
      h.symbol,
      h.quantity,
      h.average_cost_cents,
      i.name,
      i.exchange,
      i.sector,
      i.listing_currency,
      i.base_price_cents,
      i.previous_close_cents,
      i.fx_rate_basis_points
    FROM public.holdings AS h
    JOIN public.instruments AS i ON i.symbol = h.symbol
    WHERE h.team_id = ${teamId}
      AND h.quantity > 0
    ORDER BY h.symbol ASC
  `;

  const interim = await Promise.all(
    holdingRows.map(async (row) => {
      const quote = await quoteForInstrument(
        rowToInstrument(row),
        at,
        true,
        allowStoredQuoteFallback,
      );

      if (!quote) {
        throw new AppError(
          "QUOTE_UNAVAILABLE",
          `No quote is available for ${row.symbol}.`,
          503,
        );
      }

      const quantity = databaseInteger(row.quantity, "holding quantity");
      const averageCostCents = databaseInteger(
        row.average_cost_cents,
        "average cost",
      );
      const currentPriceCents = databaseInteger(
        quote.priceCents,
        "quote price",
      );
      const currentPriceCadCents = databaseInteger(
        quote.priceCadCents,
        "CAD quote price",
      );
      const previousCloseCadCents = databaseInteger(
        quote.previousCloseCadCents,
        "previous CAD close",
      );
      const marketValueCents = safeMultiply(
        currentPriceCadCents,
        quantity,
        "market value",
      );
      const costBasisCents = safeMultiply(
        averageCostCents,
        quantity,
        "cost basis",
      );
      const gainLossCents = safeSubtract(
        marketValueCents,
        costBasisCents,
        "gain/loss",
      );
      const dayPriceChangeCents = safeSubtract(
        currentPriceCadCents,
        previousCloseCadCents,
        "daily price change",
      );

      return {
        quote,
        quantity,
        averageCostCents,
        currentPriceCents,
        currentPriceCadCents,
        marketValueCents,
        costBasisCents,
        gainLossCents,
        dayChangeCents: safeMultiply(
          dayPriceChangeCents,
          quantity,
          "daily position change",
        ),
      };
    }),
  );

  const holdingsValueCents = interim.reduce(
    (total, holding) =>
      safeAdd(total, holding.marketValueCents, "holdings value"),
    0,
  );
  const cashCents = databaseInteger(team.cash_cents, "team cash");
  const totalValueCents = safeAdd(
    cashCents,
    holdingsValueCents,
    "portfolio value",
  );
  const dayChangeCents = interim.reduce(
    (total, holding) =>
      safeAdd(total, holding.dayChangeCents, "daily portfolio change"),
    0,
  );
  const priorValueCents = safeSubtract(
    totalValueCents,
    dayChangeCents,
    "prior portfolio value",
  );
  const totalReturnCents = safeSubtract(
    totalValueCents,
    competition.startingCashCents,
    "total return",
  );
  const holdings: HoldingView[] = interim
    .map((holding) => ({
      symbol: holding.quote.symbol,
      name: holding.quote.name,
      exchange: holding.quote.exchange,
      listingCurrency: holding.quote.listingCurrency,
      quantity: holding.quantity,
      averageCostCents: holding.averageCostCents,
      currentPriceCents: holding.currentPriceCents,
      currentPriceCadCents: holding.currentPriceCadCents,
      marketValueCents: holding.marketValueCents,
      costBasisCents: holding.costBasisCents,
      gainLossCents: holding.gainLossCents,
      gainLossPercent: roundPercent(
        holding.gainLossCents,
        holding.costBasisCents,
      ),
      portfolioWeightPercent: roundPercent(
        holding.marketValueCents,
        totalValueCents,
      ),
      quoteAsOf: holding.quote.asOf,
    }))
    .sort((left, right) => right.marketValueCents - left.marketValueCents);

  return {
    summary: {
      cashCents,
      holdingsValueCents,
      totalValueCents,
      startingValueCents: competition.startingCashCents,
      totalReturnCents,
      totalReturnPercent: roundPercent(
        totalReturnCents,
        competition.startingCashCents,
      ),
      dayChangeCents,
      dayChangePercent: roundPercent(dayChangeCents, priorValueCents),
      buyingPowerCents: cashCents,
      asOf: at.toISOString(),
    },
    holdings,
  };
}

export async function calculatePostgresPortfolio(
  teamId: string,
  at: Date = new Date(),
  executor: PostgresExecutor = getPostgresClient(),
  allowStoredQuoteFallback = false,
): Promise<PortfolioCalculation> {
  const competition = await getPostgresCompetitionSummary(executor);
  return calculatePortfolioWithCompetition(
    teamId,
    at,
    competition,
    executor,
    allowStoredQuoteFallback,
  );
}

function orderRowToView(row: OrderRow): OrderView {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    teamId: row.team_id,
    teamName: row.team_name,
    actorUserId: row.actor_user_id,
    actorName: row.actor_name,
    symbol: row.symbol,
    side: row.side,
    quantity: databaseInteger(row.quantity, "order quantity"),
    fillPriceCents: databaseInteger(row.fill_price_cents, "fill price"),
    fillPriceCadCents: databaseInteger(
      row.fill_price_cad_cents,
      "CAD fill price",
    ),
    grossCents: databaseInteger(row.gross_cents, "order gross"),
    status: row.status,
    createdAt: isoTimestamp(row.created_at, "order creation"),
  };
}

async function listOrdersForUser(
  user: SessionUser,
  limit: number | undefined,
  requestedTeamId: string | undefined,
  executor: PostgresExecutor,
): Promise<OrderView[]> {
  const resultLimit = normalizedLimit(limit, 12);
  const teamId = user.role === "host" ? requestedTeamId : user.teamId;

  if (user.role === "student" && !teamId) {
    throw new AppError("TEAM_REQUIRED", "Join a team to view orders.", 403);
  }

  const rows = teamId
    ? await executor<OrderRow[]>`
        SELECT
          o.id,
          COALESCE(ir.idempotency_key, o.idempotency_key) AS idempotency_key,
          o.team_id,
          t.name AS team_name,
          o.actor_user_id,
          u.name AS actor_name,
          o.symbol,
          o.side,
          o.quantity,
          o.fill_price_cents,
          o.fill_price_cad_cents,
          o.gross_cents,
          o.status,
          o.created_at
        FROM public.orders AS o
        JOIN public.teams AS t ON t.id = o.team_id
        JOIN public.users AS u ON u.id = o.actor_user_id
        LEFT JOIN public.idempotency_records AS ir ON ir.order_id = o.id
        WHERE o.team_id = ${teamId}
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT ${resultLimit}
      `
    : await executor<OrderRow[]>`
        SELECT
          o.id,
          COALESCE(ir.idempotency_key, o.idempotency_key) AS idempotency_key,
          o.team_id,
          t.name AS team_name,
          o.actor_user_id,
          u.name AS actor_name,
          o.symbol,
          o.side,
          o.quantity,
          o.fill_price_cents,
          o.fill_price_cad_cents,
          o.gross_cents,
          o.status,
          o.created_at
        FROM public.orders AS o
        JOIN public.teams AS t ON t.id = o.team_id
        JOIN public.users AS u ON u.id = o.actor_user_id
        LEFT JOIN public.idempotency_records AS ir ON ir.order_id = o.id
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT ${resultLimit}
      `;

  return rows.map(orderRowToView);
}

export async function listPostgresOrders(
  userId: string,
  limit?: number,
  requestedTeamId?: string,
  executor: PostgresExecutor = getPostgresClient(),
): Promise<OrderView[]> {
  const user = await requirePostgresSessionUser(userId, executor);
  return listOrdersForUser(user, limit, requestedTeamId, executor);
}

function activityRowToItem(row: ActivityRow): ActivityItem {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    detail: row.detail,
    actorUserId: row.actor_user_id,
    actorName: row.actor_name ?? "System",
    teamId: row.team_id,
    teamName: row.team_name,
    createdAt: isoTimestamp(row.created_at, "activity creation"),
  };
}

async function listActivityForUser(
  user: SessionUser,
  competition: CompetitionSummary,
  limit: number | undefined,
  executor: PostgresExecutor,
): Promise<ActivityItem[]> {
  const resultLimit = normalizedLimit(limit, 16);

  if (user.role === "student" && !user.teamId) {
    throw new AppError("TEAM_REQUIRED", "Join a team to view activity.", 403);
  }

  const rows =
    user.role === "student"
      ? await executor<ActivityRow[]>`
          SELECT
            a.id,
            a.type,
            a.title,
            a.detail,
            a.actor_user_id,
            u.name AS actor_name,
            a.team_id,
            t.name AS team_name,
            a.created_at
          FROM public.activity_events AS a
          LEFT JOIN public.users AS u ON u.id = a.actor_user_id
          LEFT JOIN public.teams AS t ON t.id = a.team_id
          WHERE a.competition_id = ${competition.id}
            AND (a.team_id = ${user.teamId} OR a.team_id IS NULL)
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT ${resultLimit}
        `
      : await executor<ActivityRow[]>`
          SELECT
            a.id,
            a.type,
            a.title,
            a.detail,
            a.actor_user_id,
            u.name AS actor_name,
            a.team_id,
            t.name AS team_name,
            a.created_at
          FROM public.activity_events AS a
          LEFT JOIN public.users AS u ON u.id = a.actor_user_id
          LEFT JOIN public.teams AS t ON t.id = a.team_id
          WHERE a.competition_id = ${competition.id}
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT ${resultLimit}
        `;

  return rows.map(activityRowToItem);
}

export async function listPostgresActivity(
  userId: string,
  limit?: number,
  executor: PostgresExecutor = getPostgresClient(),
): Promise<ActivityItem[]> {
  const user = await requirePostgresSessionUser(userId, executor);
  const competition = await getPostgresCompetitionSummary(executor);
  return listActivityForUser(user, competition, limit, executor);
}

async function buildLeaderboard(
  user: SessionUser,
  competition: CompetitionSummary,
  at: Date,
  executor: PostgresExecutor,
): Promise<Leaderboard> {
  const teams = await executor<LeaderboardTeamRow[]>`
    SELECT
      t.id,
      t.name,
      t.status,
      t.cash_cents,
      t.version,
      COUNT(o.id) FILTER (WHERE o.status = 'FILLED') AS trade_count
    FROM public.teams AS t
    LEFT JOIN public.orders AS o ON o.team_id = t.id
    WHERE t.competition_id = ${competition.id}
    GROUP BY t.id, t.name, t.status, t.cash_cents, t.version
  `;
  const rows: Array<Omit<LeaderboardRow, "rank">> = [];

  // The transaction owns one pooled connection, so issue its SQL sequentially.
  // Provider refreshes remain internally coalesced by symbol.
  for (const team of teams) {
    const portfolio = await calculatePortfolioWithCompetition(
      team.id,
      at,
      competition,
      executor,
    );
    rows.push({
      teamId: team.id,
      teamName: team.name,
      teamStatus: team.status,
      totalValueCents: portfolio.summary.totalValueCents,
      returnCents: portfolio.summary.totalReturnCents,
      returnPercent: portfolio.summary.totalReturnPercent,
      tradeCount: databaseInteger(team.trade_count, "trade count"),
      isCurrentTeam: team.id === user.teamId,
    });
  }

  rows.sort((left, right) => {
    const leftDisqualified = left.teamStatus === "disqualified" ? 1 : 0;
    const rightDisqualified = right.teamStatus === "disqualified" ? 1 : 0;
    return (
      leftDisqualified - rightDisqualified ||
      right.totalValueCents - left.totalValueCents ||
      left.teamName.localeCompare(right.teamName)
    );
  });

  return {
    competitionId: competition.id,
    asOf: at.toISOString(),
    rows: rows.map((row, index) => ({ rank: index + 1, ...row })),
  };
}

export async function getPostgresLeaderboard(
  userId: string,
  at: Date = new Date(),
  executor: PostgresExecutor = getPostgresClient(),
): Promise<Leaderboard> {
  const user = await requirePostgresSessionUser(userId, executor);
  const competition = await getPostgresCompetitionSummary(executor);
  return buildLeaderboard(user, competition, at, executor);
}

async function getPortfolioHistory(
  teamId: string,
  current: PortfolioSummary,
  executor: PostgresExecutor,
): Promise<PortfolioPoint[]> {
  const rows = await executor<SnapshotRow[]>`
    SELECT total_value_cents, captured_at
    FROM public.portfolio_snapshots
    WHERE team_id = ${teamId}
    ORDER BY captured_at ASC
    LIMIT 30
  `;
  const history = rows.map((row) => ({
    at: isoTimestamp(row.captured_at, "portfolio snapshot"),
    valueCents: databaseInteger(row.total_value_cents, "portfolio snapshot"),
  }));

  history.push({ at: current.asOf, valueCents: current.holdingsValueCents });
  return history;
}

async function listActiveInstruments(
  executor: PostgresExecutor,
): Promise<Array<{ instrument: MarketInstrument; autoRefresh: boolean }>> {
  const rows = await executor<InstrumentRow[]>`
    SELECT
      symbol,
      name,
      exchange,
      sector,
      listing_currency,
      base_price_cents,
      previous_close_cents,
      fx_rate_basis_points,
      auto_refresh
    FROM public.instruments
    WHERE is_active = 1
    ORDER BY symbol ASC
  `;

  return rows.map((row) => ({
    instrument: rowToInstrument(row),
    autoRefresh: databaseInteger(row.auto_refresh, "auto-refresh flag") === 1,
  }));
}

export async function getPostgresDashboard(userId: string): Promise<Dashboard> {
  const client = getPostgresClient();

  return client.begin(
    "isolation level repeatable read read only",
    async (transaction) => {
      const currentUser = await requirePostgresSessionUser(userId, transaction);
      const now = new Date();
      const competition = await getPostgresCompetitionSummary(transaction);
      const team = currentUser.teamId
        ? await getPostgresTeamSummary(currentUser.teamId, transaction)
        : null;
      const calculated = currentUser.teamId
        ? await calculatePortfolioWithCompetition(
            currentUser.teamId,
            now,
            competition,
            transaction,
          )
        : null;
      const leaderboard = await buildLeaderboard(
        currentUser,
        competition,
        now,
        transaction,
      );
      const instruments = await listActiveInstruments(transaction);

      await refreshInstrumentQuotes(
        instruments
          .filter(({ autoRefresh }) => autoRefresh)
          .map(({ instrument }) => instrument),
        now,
      );

      return {
        currentUser,
        competition,
        team,
        portfolio: calculated?.summary ?? null,
        holdings: calculated?.holdings ?? [],
        portfolioHistory:
          currentUser.teamId && calculated
            ? await getPortfolioHistory(
                currentUser.teamId,
                calculated.summary,
                transaction,
              )
            : [],
        recentOrders: await listOrdersForUser(
          currentUser,
          8,
          undefined,
          transaction,
        ),
        recentActivity: await listActivityForUser(
          currentUser,
          competition,
          10,
          transaction,
        ),
        leaderboard: leaderboard.rows.slice(0, 5),
        availableSymbols: instruments.flatMap(({ instrument }) => {
          const quote = cachedQuoteForInstrument(instrument, now);
          return quote ? [quote] : [];
        }),
        serverTime: now.toISOString(),
      };
    },
  );
}
