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
  SessionUser,
  TeamStatus,
  TeamSummary,
  TradeSide,
} from "../contracts";
import { AppError } from "../errors";
import { getSessionUser } from "./auth";
import { getDatabase, withReadTransaction } from "./db";
import { getQuote, listQuotes } from "./quotes";

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

export function requireSessionUser(userId: string): SessionUser {
  const user = getSessionUser(userId);

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

export function getCompetitionSummary(): CompetitionSummary {
  const row = getDatabase()
    .prepare(`
      SELECT
        id, name, status, base_currency, starting_cash_cents,
        starts_at, ends_at
      FROM competitions
      ORDER BY created_at DESC
      LIMIT 1
    `)
    .get() as CompetitionRow | undefined;

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

export function getTeamSummary(teamId: string): TeamSummary {
  const row = getDatabase()
    .prepare("SELECT id, name, status, cash_cents, version FROM teams WHERE id = ?")
    .get(teamId) as TeamRow | undefined;

  if (!row) {
    throw new AppError("TEAM_NOT_FOUND", "That team does not exist.", 404);
  }

  const members = getDatabase()
    .prepare(`
      SELECT u.name
      FROM team_members tm
      JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = ?
      ORDER BY tm.is_captain DESC, u.name ASC
    `)
    .all(teamId) as unknown as Array<{ name: string }>;

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

export function calculatePortfolio(
  teamId: string,
  at: Date = new Date(),
): PortfolioCalculation {
  const database = getDatabase();
  const team = database
    .prepare("SELECT id, name, status, cash_cents, version FROM teams WHERE id = ?")
    .get(teamId) as TeamRow | undefined;

  if (!team) {
    throw new AppError("TEAM_NOT_FOUND", "That team does not exist.", 404);
  }

  const competition = getCompetitionSummary();
  const holdingRows = database
    .prepare(`
      SELECT symbol, quantity, average_cost_cents
      FROM holdings
      WHERE team_id = ? AND quantity > 0
      ORDER BY symbol ASC
    `)
    .all(teamId) as unknown as HoldingRow[];

  const interim = holdingRows.map((row) => {
    const quote = getQuote(row.symbol, at);

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

    return {
      quote,
      quantity,
      averageCostCents,
      marketValueCents,
      costBasisCents,
      gainLossCents,
      dayChangeCents:
        (quote.priceCadCents - quote.previousCloseCadCents) * quantity,
    };
  });

  const holdingsValueCents = interim.reduce(
    (total, holding) => total + holding.marketValueCents,
    0,
  );
  const cashCents = Number(team.cash_cents);
  const totalValueCents = cashCents + holdingsValueCents;
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
    }))
    .sort((left, right) => right.marketValueCents - left.marketValueCents);

  return {
    summary: {
      cashCents,
      holdingsValueCents,
      totalValueCents,
      startingValueCents: competition.startingCashCents,
      totalReturnCents: totalValueCents - competition.startingCashCents,
      totalReturnPercent: roundPercent(
        totalValueCents - competition.startingCashCents,
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

export function getOrderByIdempotencyKey(
  key: string,
  actorUserId?: string,
): OrderView | null {
  const row = getDatabase()
    .prepare(`
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
        (ir.idempotency_key = ? AND (? IS NULL OR ir.actor_user_id = ?))
        OR (ir.order_id IS NULL AND o.idempotency_key = ?)
      LIMIT 1
    `)
    .get(key, actorUserId ?? null, actorUserId ?? null, key) as
    | OrderRow
    | undefined;

  return row ? orderRowToView(row) : null;
}

export function listOrders(
  userId: string,
  limit?: number,
  requestedTeamId?: string,
): OrderView[] {
  const user = requireSessionUser(userId);
  const resultLimit = normalizedLimit(limit, 12);
  const teamId = user.role === "host" ? requestedTeamId : user.teamId;

  if (user.role === "student" && !teamId) {
    throw new AppError("TEAM_REQUIRED", "Join a team to view orders.", 403);
  }

  const conditions: string[] = [];
  const parameters: Array<string | number> = [];

  if (teamId) {
    conditions.push("o.team_id = ?");
    parameters.push(teamId);
  }

  parameters.push(resultLimit);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = getDatabase()
    .prepare(`
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
    `)
    .all(...parameters) as unknown as OrderRow[];

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

export function listActivity(userId: string, limit?: number): ActivityItem[] {
  const user = requireSessionUser(userId);
  const resultLimit = normalizedLimit(limit, 16);
  const competition = getCompetitionSummary();
  const parameters: Array<string | number> = [competition.id];
  let visibility = "";

  if (user.role === "student") {
    if (!user.teamId) {
      throw new AppError("TEAM_REQUIRED", "Join a team to view activity.", 403);
    }

    visibility = "AND (a.team_id = ? OR a.team_id IS NULL)";
    parameters.push(user.teamId);
  }

  parameters.push(resultLimit);
  const rows = getDatabase()
    .prepare(`
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
    `)
    .all(...parameters) as unknown as ActivityRow[];

  return rows.map(activityRowToItem);
}

function buildLeaderboard(user: SessionUser, at: Date): Leaderboard {
  const competition = getCompetitionSummary();
  const teams = getDatabase()
    .prepare(`
      SELECT id, name, status, cash_cents, version
      FROM teams
      WHERE competition_id = ?
    `)
    .all(competition.id) as unknown as TeamRow[];

  const rows = teams.map((team) => {
    const portfolio = calculatePortfolio(team.id, at).summary;
    const countRow = getDatabase()
      .prepare("SELECT COUNT(*) AS count FROM orders WHERE team_id = ? AND status = 'FILLED'")
      .get(team.id) as { count: number };

    return {
      teamId: team.id,
      teamName: team.name,
      teamStatus: team.status,
      totalValueCents: portfolio.totalValueCents,
      returnCents: portfolio.totalReturnCents,
      returnPercent: portfolio.totalReturnPercent,
      tradeCount: Number(countRow.count),
      isCurrentTeam: team.id === user.teamId,
    };
  });

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
    rows: rows.map((row, index): LeaderboardRow => ({
      rank: index + 1,
      ...row,
    })),
  };
}

export function getLeaderboard(userId: string): Leaderboard {
  return buildLeaderboard(requireSessionUser(userId), new Date());
}

function getPortfolioHistory(teamId: string, current: PortfolioSummary): PortfolioPoint[] {
  const rows = getDatabase()
    .prepare(`
      SELECT total_value_cents, captured_at
      FROM portfolio_snapshots
      WHERE team_id = ?
      ORDER BY captured_at ASC
      LIMIT 30
    `)
    .all(teamId) as unknown as Array<{
    total_value_cents: number;
    captured_at: string;
  }>;

  const history = rows.map((row) => ({
    at: row.captured_at,
    valueCents: Number(row.total_value_cents),
  }));
  history.push({ at: current.asOf, valueCents: current.holdingsValueCents });
  return history;
}

export function getDashboard(userId: string): Dashboard {
  return withReadTransaction(() => {
    const currentUser = requireSessionUser(userId);
    const now = new Date();
    const competition = getCompetitionSummary();
    const team = currentUser.teamId ? getTeamSummary(currentUser.teamId) : null;
    const calculated = currentUser.teamId
      ? calculatePortfolio(currentUser.teamId, now)
      : null;
    const leaderboard = buildLeaderboard(currentUser, now);

    return {
      currentUser,
      competition,
      team,
      portfolio: calculated?.summary ?? null,
      holdings: calculated?.holdings ?? [],
      portfolioHistory:
        currentUser.teamId && calculated
          ? getPortfolioHistory(currentUser.teamId, calculated.summary)
          : [],
      recentOrders: listOrders(currentUser.id, 8),
      recentActivity: listActivity(currentUser.id, 10),
      leaderboard: leaderboard.rows.slice(0, 5),
      availableSymbols: listQuotes(now),
      serverTime: now.toISOString(),
    };
  });
}
