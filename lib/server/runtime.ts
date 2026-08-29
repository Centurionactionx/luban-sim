import type {
  AdminOverview,
  Dashboard,
  DemoUser,
  InstrumentSearchResult,
  OrderView,
  PlaceOrderInput,
  Quote,
  QuoteHistory,
  QuoteRange,
  SetTeamCashInput,
  TradeReceipt,
  UpdateCompetitionStatusInput,
  UpdateTeamStatusInput,
  ActivityItem,
} from "../contracts";
import {
  getAdminOverview as getSqliteAdminOverview,
  resetPrototype as resetSqlitePrototype,
  setCompetitionStatus as setSqliteCompetitionStatus,
  setTeamCash as setSqliteTeamCash,
  setTeamStatus as setSqliteTeamStatus,
} from "./admin";
import { listDemoUsers as listSqliteDemoUsers } from "./auth";
import { resolveDatabaseProvider } from "./database-provider";
import {
  getPostgresAdminOverview,
  resetPostgresPrototype,
  setPostgresTeamCash,
  updatePostgresCompetitionStatus,
  updatePostgresTeamStatus,
} from "./postgres/admin";
import {
  getPostgresDashboard,
  listPostgresActivity,
  listPostgresOrders,
} from "./postgres/queries";
import {
  getPostgresQuoteHistory,
  listPostgresQuotes,
  refreshAllPostgresQuotes,
  refreshPostgresQuote,
  searchPostgresInstruments,
} from "./postgres/quotes";
import {
  placePostgresOrder,
  replayPostgresOrder,
} from "./postgres/trading";
import {
  getDashboard as getSqliteDashboard,
  listActivity as listSqliteActivity,
  listOrders as listSqliteOrders,
} from "./queries";
import {
  getQuoteHistory as getSqliteQuoteHistory,
  listQuotes as listSqliteQuotes,
  refreshAllQuotes as refreshAllSqliteQuotes,
  refreshQuote as refreshSqliteQuote,
  searchMarketInstruments as searchSqliteMarketInstruments,
} from "./quotes";
import {
  placeOrder as placeSqliteOrder,
  replayOrder as replaySqliteOrder,
} from "./trading";

export function isPostgresRuntime(): boolean {
  return resolveDatabaseProvider(process.env) === "postgres";
}

export async function listRuntimeDemoUsers(): Promise<DemoUser[]> {
  return isPostgresRuntime() ? [] : listSqliteDemoUsers();
}

export async function getRuntimeDashboard(userId: string): Promise<Dashboard> {
  return isPostgresRuntime()
    ? getPostgresDashboard(userId)
    : getSqliteDashboard(userId);
}

export async function listRuntimeActivity(
  userId: string,
  limit?: number,
): Promise<ActivityItem[]> {
  return isPostgresRuntime()
    ? listPostgresActivity(userId, limit)
    : listSqliteActivity(userId, limit);
}

export async function listRuntimeOrders(
  userId: string,
  limit?: number,
): Promise<OrderView[]> {
  return isPostgresRuntime()
    ? listPostgresOrders(userId, limit)
    : listSqliteOrders(userId, limit);
}

export async function replayRuntimeOrder(
  input: PlaceOrderInput,
): Promise<TradeReceipt | null> {
  return isPostgresRuntime()
    ? replayPostgresOrder(input)
    : replaySqliteOrder(input);
}

export async function placeRuntimeOrder(
  input: PlaceOrderInput,
  quote: Quote,
): Promise<TradeReceipt> {
  return isPostgresRuntime()
    ? placePostgresOrder(input, quote)
    : placeSqliteOrder(input);
}

export async function refreshRuntimeQuote(
  symbol: string,
): Promise<Quote | null> {
  return isPostgresRuntime()
    ? refreshPostgresQuote(symbol)
    : refreshSqliteQuote(symbol);
}

export async function refreshAllRuntimeQuotes(): Promise<void> {
  return isPostgresRuntime()
    ? refreshAllPostgresQuotes()
    : refreshAllSqliteQuotes();
}

export async function listRuntimeQuotes(): Promise<Quote[]> {
  return isPostgresRuntime() ? listPostgresQuotes() : listSqliteQuotes();
}

export async function searchRuntimeMarketInstruments(
  query: string,
): Promise<InstrumentSearchResult[]> {
  return isPostgresRuntime()
    ? searchPostgresInstruments(query)
    : searchSqliteMarketInstruments(query);
}

export async function getRuntimeQuoteHistory(
  symbol: string,
  range: QuoteRange,
): Promise<QuoteHistory> {
  return isPostgresRuntime()
    ? getPostgresQuoteHistory(symbol, range)
    : getSqliteQuoteHistory(symbol, range);
}

export async function getRuntimeAdminOverview(
  actorUserId: string,
): Promise<AdminOverview> {
  return isPostgresRuntime()
    ? getPostgresAdminOverview(actorUserId)
    : getSqliteAdminOverview(actorUserId);
}

export async function setRuntimeCompetitionStatus(
  input: UpdateCompetitionStatusInput,
): Promise<AdminOverview> {
  return isPostgresRuntime()
    ? updatePostgresCompetitionStatus(input)
    : setSqliteCompetitionStatus(input);
}

export async function setRuntimeTeamStatus(
  input: UpdateTeamStatusInput,
): Promise<AdminOverview> {
  return isPostgresRuntime()
    ? updatePostgresTeamStatus(input)
    : setSqliteTeamStatus(input);
}

export async function setRuntimeTeamCash(
  input: SetTeamCashInput,
): Promise<AdminOverview> {
  return isPostgresRuntime()
    ? setPostgresTeamCash(input)
    : setSqliteTeamCash(input);
}

export async function resetRuntimePrototype(
  actorUserId: string,
): Promise<AdminOverview> {
  return isPostgresRuntime()
    ? resetPostgresPrototype(actorUserId)
    : resetSqlitePrototype(actorUserId);
}
