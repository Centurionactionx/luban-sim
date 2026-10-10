import { after } from "next/server";

import {
  assertRequestAllowed,
  getDashboard,
  recordPortfolioSnapshot,
  runWorkingOrdersIfDue,
  isDemoLoginAllowed,
  listDemoUsers,
  MARKET_SYMBOL_PATTERN,
  normalizeMarketSymbol,
  refreshAllQuotes,
  refreshMissingQuotes,
  refreshQuotesFor,
  watchlistSymbolsFor,
} from "@/lib";
import { assertMarketDataBudget } from "@/lib/server/quotes";

import {
  handleRouteError,
  json,
  requireAuthenticatedUser,
} from "../_lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const started = performance.now();
  try {
    const user = await requireAuthenticatedUser();
    // Each dashboard read recomputes the whole leaderboard; cap how fast one
    // client can force that work. The page polls once a minute, plus once
    // after each trade or symbol switch.
    assertRequestAllowed(`poll:${user.id}`, 30);
    const authDone = performance.now();
    const params = new URL(request.url).searchParams;
    const refreshMarket = params.get("refreshMarket") !== "0";
    const rawSymbol = params.get("symbol")?.trim();
    const focusSymbol =
      rawSymbol && MARKET_SYMBOL_PATTERN.test(normalizeMarketSymbol(rawSymbol))
        ? normalizeMarketSymbol(rawSymbol)
        : null;
    // The symbol on screen is refreshed too, which can reach Yahoo.
    if (focusSymbol) assertMarketDataBudget(user.id);
    const ownSymbols = [
      ...(await watchlistSymbolsFor(user.id)),
      ...(focusSymbol ? [focusSymbol] : []),
    ];
    // Light polls skip the market refresh but must still price any holding
    // this server instance has never quoted, or valuing it would fail. The
    // shared market cache makes most of these database reads, not Yahoo calls.
    if (refreshMarket) {
      await Promise.all([
        refreshAllQuotes(),
        refreshQuotesFor(ownSymbols, { onlyMissing: false }).catch(() => {}),
      ]);
    } else {
      await Promise.all([
        refreshMissingQuotes(),
        refreshQuotesFor(ownSymbols, { onlyMissing: true }).catch(() => {}),
      ]);
    }
    const quotesDone = performance.now();
    const dashboard = await getDashboard(user.id, {
      focusSymbol,
      historyAfter: params.get("historyAfter"),
      historyTeamId: params.get("historyTeam"),
    });
    const dashboardDone = performance.now();
    // Backup price check for waiting orders, after the response is sent.
    after(runWorkingOrdersIfDue);
    // Feeds the portfolio history chart; at most one row per team every two
    // hours. A failed write must never cost the person their dashboard.
    if (dashboard.team && dashboard.portfolio) {
      await recordPortfolioSnapshot(
        dashboard.team.id,
        dashboard.portfolio.totalValueCents,
      ).catch(() => {});
    }

    const snapshotDone = performance.now();
    // Server-Timing lets devtools show where each phase's time went.
    const serverTiming = [
      `auth;dur=${(authDone - started).toFixed(1)}`,
      `quotes;desc="${refreshMarket ? "refresh" : "cached"}";dur=${(quotesDone - authDone).toFixed(1)}`,
      `dashboard;dur=${(dashboardDone - quotesDone).toFixed(1)}`,
      `snapshot;dur=${(snapshotDone - dashboardDone).toFixed(1)}`,
      `total;dur=${(snapshotDone - started).toFixed(1)}`,
    ].join(", ");

    return json(
      {
        ...dashboard,
        session: {
          user,
          demoUsers: isDemoLoginAllowed() ? await listDemoUsers() : [],
        },
      },
      { headers: { "Server-Timing": serverTiming } },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
