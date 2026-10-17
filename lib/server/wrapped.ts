import type {
  WrappedAward,
  WrappedPersonal,
  WrappedResponse,
  WrappedSummary,
  WrappedTeamStats,
} from "../contracts";
import { AppError } from "../errors";
import { DISPLAY_TIME_ZONE } from "../time";
import { requireHost } from "./admin";
import { getDb } from "./db";
import {
  buildLeaderboard,
  competitionPhaseFor,
  getCompetitionSummary,
  readRealizedGains,
  requireSessionUser,
} from "./queries";

/** The code the host types to publish; stops a stray click from revealing the results. */
const WRAPPED_PUBLISH_CODE = "789168";

interface FillRow {
  id: string;
  team_id: string;
  actor_user_id: string;
  symbol: string;
  gross_cents: number;
  created_at: string;
}

interface Tally {
  name: string;
  teamName: string;
  trades: number;
  tradedCents: number;
  symbols: Map<string, number>;
}

/** Filled orders of the real (non-sandbox) teams, oldest first; one person's when given. */
async function loadFills(competitionId: string, actorUserId?: string): Promise<FillRow[]> {
  const db = await getDb();
  const rows = await db.all<FillRow>(
    `SELECT o.id, o.team_id, o.actor_user_id, o.symbol, o.gross_cents, o.created_at
     FROM orders o
     JOIN teams t ON t.id = o.team_id
     WHERE t.competition_id = ? AND t.sandbox_owner_user_id IS NULL
       AND o.status = 'FILLED' ${actorUserId ? "AND o.actor_user_id = ?" : ""}
     ORDER BY o.created_at ASC, o.id ASC`,
    actorUserId ? [competitionId, actorUserId] : [competitionId],
  );
  return rows.map((row) => ({ ...row, gross_cents: Number(row.gross_cents) }));
}

function tallyOf(map: Map<string, Tally>, key: string, name: string, teamName: string): Tally {
  let tally = map.get(key);
  if (!tally) {
    tally = { name, teamName, trades: 0, tradedCents: 0, symbols: new Map() };
    map.set(key, tally);
  }
  return tally;
}

function addFill(tally: Tally, fill: FillRow): void {
  tally.trades += 1;
  tally.tradedCents += fill.gross_cents;
  tally.symbols.set(fill.symbol, (tally.symbols.get(fill.symbol) ?? 0) + 1);
}

/** Highest score wins; ties go to the alphabetically first name. Null when nothing scores above zero. */
function best<T>(items: T[], score: (item: T) => number, name: (item: T) => string): T | null {
  let winner: T | null = null;
  for (const item of items) {
    if (score(item) <= 0) continue;
    if (
      !winner ||
      score(item) > score(winner) ||
      (score(item) === score(winner) && name(item).localeCompare(name(winner)) < 0)
    ) {
      winner = item;
    }
  }
  return winner;
}

function favorite(symbols: Map<string, number>): string | null {
  const top = best([...symbols], ([, count]) => count, ([symbol]) => symbol);
  return top ? top[0] : null;
}

/** Minutes after midnight in Toronto, and the clock text ("11:42 p.m."). */
function torontoClock(iso: string): { minutes: number; text: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DISPLAY_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const hour = Number(parts.find((part) => part.type === "hour")!.value) % 24;
  const minute = Number(parts.find((part) => part.type === "minute")!.value);
  const text = `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "a.m." : "p.m."}`;
  return { minutes: hour * 60 + minute, text };
}

async function buildWrappedSummary(actorUserId: string, publishedAt: string): Promise<WrappedSummary> {
  const competition = await getCompetitionSummary();
  const db = await getDb();
  const board = await buildLeaderboard(await requireSessionUser(actorUserId), new Date());
  const fills = await loadFills(competition.id);
  const teamName = new Map(board.rows.map((row) => [row.teamId, row.teamName]));
  const names = new Map(
    (await db.all<{ id: string; name: string }>("SELECT id, name FROM users")).map((u) => [u.id, u.name]),
  );

  const teams = new Map<string, Tally>();
  const members = new Map<string, Tally>();
  const symbols = new Map<string, { tradedCents: number; tradeCount: number }>();
  const clocks = new Map<string, { early: ReturnType<typeof torontoClock>; late: ReturnType<typeof torontoClock> }>();
  for (const fill of fills) {
    const team = teamName.get(fill.team_id) ?? "";
    addFill(tallyOf(teams, fill.team_id, team, team), fill);
    addFill(tallyOf(members, fill.actor_user_id, names.get(fill.actor_user_id) ?? "Unknown", team), fill);
    const symbol = symbols.get(fill.symbol) ?? { tradedCents: 0, tradeCount: 0 };
    symbol.tradedCents += fill.gross_cents;
    symbol.tradeCount += 1;
    symbols.set(fill.symbol, symbol);
    const clock = torontoClock(fill.created_at);
    const seen = clocks.get(fill.actor_user_id);
    clocks.set(fill.actor_user_id, {
      early: seen && seen.early.minutes <= clock.minutes ? seen.early : clock,
      late: seen && seen.late.minutes >= clock.minutes ? seen.late : clock,
    });
  }

  // Realized gains per team, and per closing order for the member/best-trade awards.
  const realizedByTeam = new Map<string, number>();
  const memberRealized = new Map<string, number>();
  let bestTrade: { actor: string; symbol: string; cents: number } | null = null;
  const fillById = new Map(fills.map((fill) => [fill.id, fill]));
  for (const row of board.rows) {
    const realized = await readRealizedGains(row.teamId);
    realizedByTeam.set(row.teamId, realized.totalCents);
    for (const [orderId, cents] of realized.byClosingOrderId) {
      const fill = fillById.get(orderId);
      if (!fill) continue;
      memberRealized.set(fill.actor_user_id, (memberRealized.get(fill.actor_user_id) ?? 0) + cents);
      if (cents > 0 && (!bestTrade || cents > bestTrade.cents)) {
        bestTrade = { actor: fill.actor_user_id, symbol: fill.symbol, cents };
      }
    }
  }

  const snapshots = await db.all<{ team_id: string; total_value_cents: number }>(
    `SELECT s.team_id, s.total_value_cents
     FROM portfolio_snapshots s JOIN teams t ON t.id = s.team_id
     WHERE t.competition_id = ? AND t.sandbox_owner_user_id IS NULL
     ORDER BY s.captured_at ASC`,
    [competition.id],
  );
  const rejections = await db.all<{ actor_user_id: string; count: number }>(
    `SELECT r.actor_user_id, COUNT(*) AS count
     FROM order_rejections r JOIN teams t ON t.id = r.team_id
     WHERE t.competition_id = ? AND t.sandbox_owner_user_id IS NULL AND r.actor_user_id IS NOT NULL
     GROUP BY r.actor_user_id`,
    [competition.id],
  );

  const stats = board.rows.map((row) => {
    const values = snapshots
      .filter((snapshot) => snapshot.team_id === row.teamId)
      .map((snapshot) => Number(snapshot.total_value_cents));
    const all = [competition.startingCashCents, ...values, row.totalValueCents];
    const tally = teams.get(row.teamId);
    return {
      team: {
        teamId: row.teamId,
        teamName: row.teamName,
        rank: row.rank,
        finalValueCents: row.totalValueCents,
        returnPercent: row.returnPercent,
        tradeCount: row.tradeCount,
        tradedCents: tally?.tradedCents ?? 0,
        realizedCents: realizedByTeam.get(row.teamId) ?? 0,
        favoriteSymbol: tally ? favorite(tally.symbols) : null,
        peakValueCents: Math.max(...all),
      } satisfies WrappedTeamStats,
      // Only a team that fell below its starting cash can come back.
      comebackCents:
        Math.min(...all) < competition.startingCashCents ? row.totalValueCents - Math.min(...all) : 0,
      distinct: tally?.symbols.size ?? 0,
    };
  });

  const teamAward = (
    winner: (typeof stats)[number] | null,
    fields: Partial<WrappedAward>,
  ): WrappedAward | null =>
    winner && { name: winner.team.teamName, teamName: winner.team.teamName, ...fields };
  const memberAward = (
    entry: [string, Tally] | null,
    fields: Partial<WrappedAward>,
  ): WrappedAward | null => entry && { name: entry[1].name, teamName: entry[1].teamName, ...fields };
  const byName = (item: (typeof stats)[number]) => item.team.teamName;
  const memberList = [...members];
  const memberName = ([, tally]: [string, Tally]) => tally.name;
  const clockAward = (pick: "early" | "late") => {
    // +1 keeps a midnight trade above best()'s zero cutoff.
    const entry = best(
      memberList,
      ([id]) => {
        const minutes = clocks.get(id)![pick].minutes;
        return pick === "late" ? minutes + 1 : 24 * 60 - minutes;
      },
      memberName,
    );
    return memberAward(entry, { detail: entry ? clocks.get(entry[0])![pick].text : undefined });
  };
  const loss = best(stats, (item) => -item.team.realizedCents, byName);
  const gain = best(stats, (item) => item.team.realizedCents, byName);
  const bestTradeMember = bestTrade && ([bestTrade.actor, members.get(bestTrade.actor)!] as [string, Tally]);
  const rejected = best(
    rejections.filter((row) => names.has(row.actor_user_id)),
    (row) => Number(row.count),
    (row) => names.get(row.actor_user_id)!,
  );
  const rejectedTeam = rejected
    ? (await db.get<{ name: string }>(
        `SELECT t.name FROM team_members m JOIN teams t ON t.id = m.team_id
         WHERE m.user_id = ? AND t.sandbox_owner_user_id IS NULL`,
        [rejected.actor_user_id],
      ))?.name ?? ""
    : "";

  return {
    competitionId: competition.id,
    competitionName: competition.name,
    publishedAt,
    totalTrades: fills.length,
    totalTradedCents: fills.reduce((total, fill) => total + fill.gross_cents, 0),
    teams: stats.map((item) => item.team),
    awards: {
      mostTraded: (() => {
        const w = best(stats, (item) => item.team.tradedCents, byName);
        return teamAward(w, { valueCents: w?.team.tradedCents });
      })(),
      mostTrades: (() => {
        const w = best(stats, (item) => item.team.tradeCount, byName);
        return teamAward(w, { count: w?.team.tradeCount });
      })(),
      biggestLoss: teamAward(loss, { valueCents: loss?.team.realizedCents }),
      biggestGain: teamAward(gain, { valueCents: gain?.team.realizedCents }),
      biggestComeback: (() => {
        const w = best(stats, (item) => item.comebackCents, byName);
        return teamAward(w, { valueCents: w?.comebackCents });
      })(),
      mostDiversified: (() => {
        const w = best(stats, (item) => item.distinct, byName);
        return teamAward(w, { count: w?.distinct });
      })(),
      topTrader: (() => {
        const w = best(memberList, ([, tally]) => tally.tradedCents, memberName);
        return memberAward(w, { valueCents: w?.[1].tradedCents });
      })(),
      bestTrade: memberAward(bestTradeMember, {
        valueCents: bestTrade?.cents,
        detail: bestTrade?.symbol,
      }),
      nightOwl: clockAward("late"),
      earlyBird: clockAward("early"),
      mostRejected: rejected
        ? { name: names.get(rejected.actor_user_id)!, teamName: rejectedTeam, count: Number(rejected.count) }
        : null,
    },
    topSymbols: [...symbols]
      .map(([symbol, value]) => ({ symbol, ...value }))
      .sort((a, b) => b.tradedCents - a.tradedCents || a.symbol.localeCompare(b.symbol))
      .slice(0, 5),
  };
}

/** Host-only: freezes the final stats once the competition has ended; republishing refreshes them. */
export async function publishWrapped(input: {
  actorUserId: string;
  code: string;
}): Promise<{ publishedAt: string }> {
  await requireHost(input.actorUserId);
  const competition = await getCompetitionSummary();
  if (competitionPhaseFor(competition) !== "ended") {
    throw new AppError(
      "COMPETITION_NOT_ENDED",
      "Wrapped can only be published once the competition has ended.",
      409,
    );
  }
  if (input.code !== WRAPPED_PUBLISH_CODE) {
    throw new AppError("WRAPPED_CODE_INVALID", "That code isn't right.", 403);
  }

  const publishedAt = new Date().toISOString();
  const summary = await buildWrappedSummary(input.actorUserId, publishedAt);
  const db = await getDb();
  await db.run(
    `INSERT INTO competition_wrapped (competition_id, payload, published_at, published_by_user_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (competition_id) DO UPDATE SET
       payload = excluded.payload,
       published_at = excluded.published_at,
       published_by_user_id = excluded.published_by_user_id`,
    [competition.id, JSON.stringify(summary), publishedAt, input.actorUserId],
  );
  return { publishedAt };
}

export async function getWrapped(userId: string): Promise<WrappedResponse> {
  const user = await requireSessionUser(userId);
  const competition = await getCompetitionSummary();
  const db = await getDb();
  const row = await db.get<{ payload: string }>(
    "SELECT payload FROM competition_wrapped WHERE competition_id = ?",
    [competition.id],
  );
  if (!row) {
    throw new AppError("WRAPPED_NOT_PUBLISHED", "Wrapped hasn't been published yet.", 404);
  }

  const team = await db.get<{ id: string; name: string }>(
    `SELECT t.id, t.name FROM team_members m JOIN teams t ON t.id = m.team_id
     WHERE m.user_id = ? AND t.competition_id = ? AND t.sandbox_owner_user_id IS NULL`,
    [userId, competition.id],
  );
  let personal: WrappedPersonal | null = null;
  if (team) {
    const mine = await loadFills(competition.id, userId);
    const tally = tallyOf(new Map(), userId, user.name, team.name);
    mine.forEach((fill) => addFill(tally, fill));
    const realized = await readRealizedGains(team.id);
    const bySymbol = new Map(mine.map((fill) => [fill.id, fill.symbol]));
    let realizedCents = 0;
    let bestTrade: WrappedPersonal["bestTrade"] = null;
    for (const [orderId, cents] of realized.byClosingOrderId) {
      const symbol = bySymbol.get(orderId);
      if (!symbol) continue;
      realizedCents += cents;
      if (cents > 0 && (!bestTrade || cents > bestTrade.realizedCents)) {
        bestTrade = { symbol, realizedCents: cents };
      }
    }
    // Everyone on a real team counts as a trader, including those with no trades.
    const counts = await db.all<{ count: number }>(
      `SELECT (SELECT COUNT(*) FROM orders o WHERE o.actor_user_id = m.user_id AND o.status = 'FILLED'
                 AND o.team_id = m.team_id) AS count
       FROM team_members m JOIN teams t ON t.id = m.team_id
       WHERE t.competition_id = ? AND t.sandbox_owner_user_id IS NULL`,
      [competition.id],
    );
    const fewer = counts.filter((entry) => Number(entry.count) < tally.trades).length;
    personal = {
      name: user.name,
      teamName: team.name,
      tradeCount: tally.trades,
      tradedCents: tally.tradedCents,
      realizedCents,
      favoriteSymbol: favorite(tally.symbols),
      bestTrade,
      tradeCountPercentile: counts.length ? Math.round((fewer / counts.length) * 100) : 0,
    };
  }

  return { summary: JSON.parse(row.payload) as WrappedSummary, personal };
}
