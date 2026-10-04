import { randomUUID } from "node:crypto";

import type {
  ActivityItem,
  CompetitionPhase,
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
} from "../contracts";
import { AppError } from "../errors";
import { getAdminTradingTeamId } from "./admin-trading";
import { getSessionUser } from "./auth";
import { getDb, withReadTransaction } from "./db";
import { getQuote, listQuotes, quoteCacheGeneration } from "./quotes";
import { readReservations } from "./working-order-book";

interface CompetitionRow {
  id: string;
  name: string;
  status: CompetitionStatus;
  base_currency: "CAD";
  starting_cash_cents: number;
  starts_at: string;
  ends_at: string;
}

interface TeamRow {
  id: string;
  name: string;
  status: TeamStatus;
  cash_cents: number;
  version: number;
  sandbox_owner_user_id: string | null;
}

interface HoldingRow {
  symbol: string;
  quantity: number;
  average_cost_cents: number;
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
  quantity: number;
  fill_price_cents: number;
  fill_price_cad_cents: number;
  gross_cents: number;
  status: OrderStatus;
  created_at: string;
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
  created_at: string;
}

function roundPercent(numerator: number, denominator: number): number {
  if (denominator === 0) {
    return 0;
  }

  return Math.round((numerator / denominator) * 10_000) / 100;
}

function normalizedLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined) {
    return fallback;
  }

  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new AppError("INVALID_LIMIT", "Limit must be a positive integer.", 400);
  }

  return Math.min(limit, 100);
}

export async function requireSessionUser(userId: string): Promise<SessionUser> {
  const user = await getSessionUser(userId);

  if (!user) {
    throw new AppError("UNAUTHORIZED", "Sign in to continue.", 401);
  }

  return user;
}

/**
 * Where the competition stands right now. The stored status is the host's
 * intent (draft/active/paused/ended); the schedule window turns "active"
 * into "scheduled" before the start and "ended" after the end, so starting
 * and stopping need no background job — every read and every trade computes
 * this from the same clock.
 */
export function competitionPhaseFor(
  competition: { status: CompetitionStatus; startsAt: string; endsAt: string },
  now: Date = new Date(),
): CompetitionPhase {
  if (competition.status !== "active") {
    return competition.status;
  }

  const nowIso = now.toISOString();

  if (nowIso < competition.startsAt) {
    return "scheduled";
  }

  if (nowIso >= competition.endsAt) {
    return "ended";
  }

  return "open";
}

export async function getCompetitionSummary(): Promise<CompetitionSummary> {
  const db = await getDb();
  const row = await db.get<CompetitionRow>(`
      SELECT
        id, name, status, base_currency, starting_cash_cents,
        starts_at, ends_at
      FROM competitions
      ORDER BY created_at DESC
      LIMIT 1
    `);

  if (!row) {
    throw new AppError("COMPETITION_NOT_FOUND", "No competition is configured.", 404);
  }

  const phase = competitionPhaseFor({
    status: row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
  });

  return {
    id: row.id,
    name: row.name,
    status: row.status,
    phase,
    tradingOpen: phase === "open",
    baseCurrency: row.base_currency,
    startingCashCents: Number(row.starting_cash_cents),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
  };
}

export async function getTeamSummary(
  teamId: string,
  sandboxOwnerUserId?: string,
): Promise<TeamSummary> {
  const db = await getDb();
  const ownerVisibility = sandboxOwnerUserId
    ? "AND sandbox_owner_user_id = ?"
    : "AND sandbox_owner_user_id IS NULL";
  const params = sandboxOwnerUserId
    ? [teamId, sandboxOwnerUserId]
    : [teamId];
  const row = await db.get<TeamRow>(
    `SELECT id, name, status, cash_cents, version, sandbox_owner_user_id
     FROM teams
     WHERE id = ? ${ownerVisibility}`,
    params,
  );

  if (!row) {
    throw new AppError("TEAM_NOT_FOUND", "That team does not exist.", 404);
  }

  const members = await db.all<{ name: string }>(
    `
      SELECT u.name
      FROM team_members tm
      JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = ?
      ORDER BY tm.is_captain DESC, u.name ASC
    `,
    [teamId],
  );

  return {
    id: row.id,
    name: row.name,
    status: row.status,
    memberNames: members.map((member) => member.name),
    version: Number(row.version),
  };
}

export interface PortfolioCalculation {
  summary: PortfolioSummary;
  holdings: HoldingView[];
}

export async function calculatePortfolio(
  teamId: string,
  at: Date = new Date(),
  sandboxOwnerUserId?: string,
): Promise<PortfolioCalculation> {
  const database = await getDb();
  const ownerVisibility = sandboxOwnerUserId
    ? "AND sandbox_owner_user_id = ?"
    : "AND sandbox_owner_user_id IS NULL";
  const params = sandboxOwnerUserId
    ? [teamId, sandboxOwnerUserId]
    : [teamId];
  const team = await database.get<TeamRow>(
    `SELECT id, name, status, cash_cents, version, sandbox_owner_user_id
     FROM teams WHERE id = ? ${ownerVisibility}`,
    params,
  );

  if (!team) {
    throw new AppError("TEAM_NOT_FOUND", "That team does not exist.", 404);
  }

  const competition = await getCompetitionSummary();
  const holdingRows = await database.all<HoldingRow>(
    `
      SELECT symbol, quantity, average_cost_cents
      FROM holdings
      WHERE team_id = ? AND quantity > 0
      ORDER BY symbol ASC
    `,
    [teamId],
  );

  const interim: Array<{
    quote: Quote;
    quantity: number;
    averageCostCents: number;
    marketValueCents: number;
    costBasisCents: number;
    gainLossCents: number;
    dayChangeCents: number;
  }> = [];

  for (const row of holdingRows) {
    const quote = await getQuote(row.symbol, at);

    if (!quote) {
      throw new AppError(
        "QUOTE_UNAVAILABLE",
        `No quote is available for ${row.symbol}.`,
        503,
      );
    }

    const quantity = Number(row.quantity);
    const averageCostCents = Number(row.average_cost_cents);
    const marketValueCents = quote.priceCadCents * quantity;
    const costBasisCents = averageCostCents * quantity;
    const gainLossCents = marketValueCents - costBasisCents;

    interim.push({
      quote,
      quantity,
      averageCostCents,
      marketValueCents,
      costBasisCents,
      gainLossCents,
      dayChangeCents:
        (quote.priceCadCents - quote.previousCloseCadCents) * quantity,
    });
  }

  const reservedCashCents = (await readReservations(database, teamId)).cashCents;
  const holdingsValueCents = interim.reduce(
    (total, holding) => total + holding.marketValueCents,
    0,
  );
  const cashCents = Number(team.cash_cents);
  const totalValueCents = cashCents + holdingsValueCents;
  const sandboxFunding = team.sandbox_owner_user_id
    ? await database.get<{ amount_cents: number }>(
        `SELECT COALESCE(SUM(amount_cents), 0) AS amount_cents
         FROM ledger_entries
         WHERE team_id = ?
           AND entry_type IN ('STARTING_CASH', 'ADJUSTMENT')`,
        [teamId],
      )
    : null;
  const startingValueCents = team.sandbox_owner_user_id
    ? Number(sandboxFunding?.amount_cents ?? 0)
    : competition.startingCashCents;
  const dayChangeCents = interim.reduce(
    (total, holding) => total + holding.dayChangeCents,
    0,
  );
  const priorValueCents = totalValueCents - dayChangeCents;

  const holdings: HoldingView[] = interim
    .map((holding) => ({
      symbol: holding.quote.symbol,
      name: holding.quote.name,
      exchange: holding.quote.exchange,
      listingCurrency: holding.quote.listingCurrency,
      quantity: holding.quantity,
      averageCostCents: holding.averageCostCents,
      currentPriceCents: holding.quote.priceCents,
      currentPriceCadCents: holding.quote.priceCadCents,
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
      assetClass: holding.quote.assetClass ?? "STOCK",
      lotSize: holding.quote.lotSize ?? 1,
    }))
    .sort((left, right) => right.marketValueCents - left.marketValueCents);

  return {
    summary: {
      cashCents,
      holdingsValueCents,
      totalValueCents,
      startingValueCents,
      totalReturnCents: totalValueCents - startingValueCents,
      totalReturnPercent:
        startingValueCents > 0
          ? roundPercent(totalValueCents - startingValueCents, startingValueCents)
          : 0,
      dayChangeCents,
      dayChangePercent: roundPercent(dayChangeCents, priorValueCents),
      // Cash set aside for waiting buy orders can't be spent twice.
      buyingPowerCents: cashCents - reservedCashCents,
      asOf: at.toISOString(),
    },
    holdings,
  };
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
    quantity: Number(row.quantity),
    fillPriceCents: Number(row.fill_price_cents),
    fillPriceCadCents: Number(row.fill_price_cad_cents),
    grossCents: Number(row.gross_cents),
    status: row.status,
    createdAt: row.created_at,
  };
}

export async function getOrderByIdempotencyKey(
  key: string,
  actorUserId?: string,
): Promise<OrderView | null> {
  const db = await getDb();
  // The optional-actor filter is decided here rather than with a
  // `? IS NULL` SQL trick: PostgreSQL cannot infer a type for a parameter
  // that only appears in an IS NULL test.
  const actorFilter = actorUserId ? "AND ir.actor_user_id = ?" : "";
  const legacyActorFilter = actorUserId ? "AND o.actor_user_id = ?" : "";
  const params = actorUserId ? [key, actorUserId, key, actorUserId] : [key, key];
  const row = await db.get<OrderRow>(
    `
      SELECT
        o.id, COALESCE(ir.idempotency_key, o.idempotency_key) AS idempotency_key,
        o.team_id, t.name AS team_name,
        o.actor_user_id, u.name AS actor_name, o.symbol, o.side,
        o.quantity, o.fill_price_cents, o.fill_price_cad_cents,
        o.gross_cents, o.status, o.created_at
      FROM orders o
      JOIN teams t ON t.id = o.team_id
      JOIN users u ON u.id = o.actor_user_id
      LEFT JOIN idempotency_records ir ON ir.order_id = o.id
      WHERE
        (ir.idempotency_key = ? ${actorFilter})
        OR (ir.order_id IS NULL AND o.idempotency_key = ? ${legacyActorFilter})
      LIMIT 1
    `,
    params,
  );

  return row ? orderRowToView(row) : null;
}

export async function listOrders(
  userId: string,
  limit?: number,
  requestedTeamId?: string,
): Promise<OrderView[]> {
  const user = await requireSessionUser(userId);
  const resultLimit = normalizedLimit(limit, 12);
  const teamId =
    user.role === "platform_admin"
      ? await getAdminTradingTeamId(user.id)
      : user.role === "host"
        ? requestedTeamId
        : user.teamId;

  if (user.role === "student" && !teamId) {
    return [];
  }

  const conditions: string[] = [];
  const parameters: Array<string | number> = [];

  if (user.role === "host") {
    // Hosts may inspect real competition teams, never a private admin row.
    conditions.push("t.sandbox_owner_user_id IS NULL");
  }

  if (user.role === "platform_admin" && !teamId) {
    return [];
  }

  if (teamId) {
    conditions.push("o.team_id = ?");
    parameters.push(teamId);
  }

  parameters.push(resultLimit);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const db = await getDb();
  const rows = await db.all<OrderRow>(
    `
      SELECT
        o.id, COALESCE(ir.idempotency_key, o.idempotency_key) AS idempotency_key,
        o.team_id, t.name AS team_name,
        o.actor_user_id, u.name AS actor_name, o.symbol, o.side,
        o.quantity, o.fill_price_cents, o.fill_price_cad_cents,
        o.gross_cents, o.status, o.created_at
      FROM orders o
      JOIN teams t ON t.id = o.team_id
      JOIN users u ON u.id = o.actor_user_id
      LEFT JOIN idempotency_records ir ON ir.order_id = o.id
      ${where}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT ?
    `,
    parameters,
  );

  return rows.map(orderRowToView);
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
    createdAt: row.created_at,
  };
}

export async function listActivity(
  userId: string,
  limit?: number,
  scope: "portfolio" | "competition" = "portfolio",
): Promise<ActivityItem[]> {
  const user = await requireSessionUser(userId);
  const resultLimit = normalizedLimit(limit, 16);
  const competition = await getCompetitionSummary();
  const parameters: Array<string | number> = [competition.id];
  let visibility = "";

  if (user.role === "student") {
    if (!user.teamId) {
      return [];
    }

    visibility = "AND a.team_id = ?";
    parameters.push(user.teamId);
  } else if (user.role === "platform_admin" && scope === "portfolio") {
    const teamId = await getAdminTradingTeamId(user.id);
    visibility = teamId
      ? "AND (a.team_id = ? OR a.team_id IS NULL)"
      : "AND a.team_id IS NULL";
    if (teamId) parameters.push(teamId);
  } else {
    // Competition oversight includes global events and real teams only.
    visibility =
      "AND (a.team_id IS NULL OR t.sandbox_owner_user_id IS NULL)";
  }

  parameters.push(resultLimit);
  const db = await getDb();
  const rows = await db.all<ActivityRow>(
    `
      SELECT
        a.id, a.type, a.title, a.detail,
        a.actor_user_id, u.name AS actor_name,
        a.team_id, t.name AS team_name, a.created_at
      FROM activity_events a
      LEFT JOIN users u ON u.id = a.actor_user_id
      LEFT JOIN teams t ON t.id = a.team_id
      WHERE a.competition_id = ? ${visibility}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ?
    `,
    parameters,
  );

  return rows.map(activityRowToItem);
}

type RankedRow = Omit<LeaderboardRow, "rank" | "isCurrentTeam">;

/**
 * Every dashboard poll needs the leaderboard, and valuing each team costs
 * several queries. The ranking only changes when a team row changes (every
 * trade, cash, status, or name change bumps its version) or a quote changes,
 * so it is memoized per process on exactly those inputs.
 */
const leaderboardCache = new Map<string, { key: string; rows: RankedRow[] }>();

async function buildLeaderboard(user: SessionUser, at: Date): Promise<Leaderboard> {
  const competition = await getCompetitionSummary();
  const db = await getDb();
  const teams = await db.all<TeamRow>(
    `
      SELECT id, name, status, cash_cents, version, sandbox_owner_user_id
      FROM teams
      WHERE competition_id = ? AND sandbox_owner_user_id IS NULL
      ORDER BY id ASC
    `,
    [competition.id],
  );
  const cacheKey = JSON.stringify([
    competition.startingCashCents,
    quoteCacheGeneration(),
    Math.floor(at.getTime() / 60_000),
    teams.map((team) => [team.id, Number(team.version)]),
  ]);
  let ranked = leaderboardCache.get(competition.id);

  if (!ranked || ranked.key !== cacheKey) {
    const counts = await db.all<{ team_id: string; count: number }>(
      `
        SELECT o.team_id, COUNT(*) AS count
        FROM orders o
        JOIN teams t ON t.id = o.team_id
        WHERE t.competition_id = ? AND t.sandbox_owner_user_id IS NULL
          AND o.status = 'FILLED'
        GROUP BY o.team_id
      `,
      [competition.id],
    );
    const tradeCounts = new Map(
      counts.map((row) => [row.team_id, Number(row.count)]),
    );
    const rows: RankedRow[] = [];

    for (const team of teams) {
      const portfolio = (await calculatePortfolio(team.id, at)).summary;
      rows.push({
        teamId: team.id,
        teamName: team.name,
        teamStatus: team.status,
        totalValueCents: portfolio.totalValueCents,
        returnCents: portfolio.totalReturnCents,
        returnPercent: portfolio.totalReturnPercent,
        tradeCount: tradeCounts.get(team.id) ?? 0,
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

    ranked = { key: cacheKey, rows };
    leaderboardCache.clear();
    leaderboardCache.set(competition.id, ranked);
  }

  return {
    competitionId: competition.id,
    asOf: at.toISOString(),
    rows: ranked.rows.map((row, index): LeaderboardRow => ({
      rank: index + 1,
      ...row,
      isCurrentTeam: row.teamId === user.teamId,
    })),
  };
}

export async function getLeaderboard(userId: string): Promise<Leaderboard> {
  return buildLeaderboard(await requireSessionUser(userId), new Date());
}

/** Snapshots are recorded at most this often per portfolio. */
const SNAPSHOT_INTERVAL_MS = 2 * 60 * 60_000;
/** Two months of two-hourly snapshots; the newest are kept. */
const SNAPSHOT_HISTORY_LIMIT = 720;

/**
 * Total portfolio value over time: the competition's start (when every team
 * held exactly its starting cash), the recorded snapshots, then the current
 * valuation. Total value is what teams are ranked on, so it is what the
 * chart shows.
 */
async function getPortfolioHistory(
  teamId: string,
  current: PortfolioSummary,
  start: PortfolioPoint | null,
): Promise<PortfolioPoint[]> {
  const db = await getDb();
  const rows = await db.all<{
    total_value_cents: number;
    captured_at: string;
  }>(
    `
      SELECT total_value_cents, captured_at
      FROM portfolio_snapshots
      WHERE team_id = ?
      ORDER BY captured_at DESC
      LIMIT ?
    `,
    [teamId, SNAPSHOT_HISTORY_LIMIT],
  );

  const history = rows.reverse().map((row) => ({
    at: row.captured_at,
    valueCents: Number(row.total_value_cents),
  }));
  if (
    start &&
    start.at < current.asOf &&
    (history.length === 0 || start.at < history[0].at)
  ) {
    history.unshift(start);
  }
  history.push({ at: current.asOf, valueCents: current.totalValueCents });
  return history;
}

/**
 * Record a portfolio's total value for its history chart, at most once per
 * snapshot interval. The conditional insert keeps concurrent dashboard loads
 * on different server instances from writing duplicates.
 */
export async function recordPortfolioSnapshot(
  teamId: string,
  totalValueCents: number,
  at: Date = new Date(),
): Promise<void> {
  const db = await getDb();
  await db.run(
    `
      INSERT INTO portfolio_snapshots (id, team_id, total_value_cents, captured_at)
      SELECT ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM portfolio_snapshots
        WHERE team_id = ? AND captured_at > ?
      )
    `,
    [
      randomUUID(),
      teamId,
      totalValueCents,
      at.toISOString(),
      teamId,
      new Date(at.getTime() - SNAPSHOT_INTERVAL_MS).toISOString(),
    ],
  );
}

export async function getDashboard(userId: string): Promise<Dashboard> {
  return withReadTransaction(async () => {
    const currentUser = await requireSessionUser(userId);
    const now = new Date();
    const competition = await getCompetitionSummary();
    const portfolioTeamId =
      currentUser.role === "platform_admin"
        ? await getAdminTradingTeamId(currentUser.id)
        : currentUser.teamId;
    const team = portfolioTeamId
      ? await getTeamSummary(
          portfolioTeamId,
          currentUser.role === "platform_admin" ? currentUser.id : undefined,
        )
      : null;
    const calculated = portfolioTeamId
      ? await calculatePortfolio(
          portfolioTeamId,
          now,
          currentUser.role === "platform_admin" ? currentUser.id : undefined,
        )
      : null;
    const leaderboard = await buildLeaderboard(currentUser, now);

    return {
      currentUser,
      competition,
      team,
      portfolio: calculated?.summary ?? null,
      holdings: calculated?.holdings ?? [],
      portfolioHistory:
        portfolioTeamId && calculated
          ? await getPortfolioHistory(
              portfolioTeamId,
              calculated.summary,
              // Competition teams all start from the same known value; the
              // admin sandbox has no shared start.
              currentUser.role !== "platform_admin" &&
                competition.startsAt <= now.toISOString()
                ? {
                    at: competition.startsAt,
                    valueCents: competition.startingCashCents,
                  }
                : null,
            )
          : [],
      recentOrders: await listOrders(currentUser.id, 8),
      recentActivity: await listActivity(currentUser.id, 10),
      leaderboard: leaderboard.rows.slice(0, 5),
      availableSymbols: await listQuotes(now),
      serverTime: now.toISOString(),
    };
  });
}
