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

import {
  handleRouteError,
  json,
  requireAuthenticatedUser,
} from "../_lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireAuthenticatedUser();
    // Each dashboard read recomputes the whole leaderboard; cap how fast one
    // client can force that work. Well above any legitimate polling cadence.
    assertRequestAllowed(`poll:${user.id}`, 120);
    const params = new URL(request.url).searchParams;
    const refreshMarket = params.get("refreshMarket") !== "0";
    const rawSymbol = params.get("symbol")?.trim();
    const focusSymbol =
      rawSymbol && MARKET_SYMBOL_PATTERN.test(normalizeMarketSymbol(rawSymbol))
        ? normalizeMarketSymbol(rawSymbol)
        : null;
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
    const dashboard = await getDashboard(user.id, {
      focusSymbol,
      historyAfter: params.get("historyAfter"),
      historyTeamId: params.get("historyTeam"),
    });
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

    return json({
      ...dashboard,
      session: {
        user,
        demoUsers: isDemoLoginAllowed() ? await listDemoUsers() : [],
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
