export * from "./contracts";
export * from "./history-options";
export * from "./errors";

export {
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  createSessionToken,
  getSessionFromToken,
  getSessionUser,
  invalidateSessionToken,
  listDemoUsers,
  readSessionTokenFromCookieHeader,
  serializeClearedSessionCookie,
  serializeSessionCookie,
  sessionCookieOptions,
  verifySessionToken,
} from "./server/auth";

export {
  getAuthMode,
  isDemoLoginAllowed,
  isManagedAuthMode,
} from "./server/auth-mode";

export {
  assertRequestAllowed,
  resetRequestThrottle,
} from "./server/request-throttle";

export {
  listAuthAuditEvents,
  recordAuthAuditEvent,
} from "./server/audit";

export {
  DEFAULT_INVITATION_TTL_HOURS,
  MAX_INVITATION_TTL_HOURS,
  MIN_INVITATION_TTL_HOURS,
  consumeInvitation,
  createInvitation,
  createSystemAdminInvitation,
  listInvitations,
  previewInvitation,
  revokeInvitation,
} from "./server/invitations";

export type { ManagedIdentity } from "./server/invitations";

export { resolveManagedSubject, resolveManagedUser } from "./server/accounts";

export {
  deleteAccount,
  deleteOwnAccount,
  listAccounts,
  setAccountRole,
  setAccountName,
  setAccountStatus,
  setAccountTeam,
} from "./server/account-management";

export type { ManagedResolution } from "./server/accounts";

export { listAdminLog, listAdminLogOptions } from "./server/admin-log";

export {
  COMPETITION_STATUSES,
  MAX_TEAM_CASH_CENTS,
  MAX_TEAM_NAME_LENGTH,
  TEAM_STATUSES,
  createCompetitionTeam,
  getAdminOverview,
  listAdminTeams,
  removeCompetitionTeam,
  renameCompetitionTeam,
  resetPrototype,
  setCompetitionStatus,
  setTeamCash,
  setTeamHolding,
  setAnnouncement,
  clearAnnouncement,
  ANNOUNCEMENT_TITLE_MAX_LENGTH,
  ANNOUNCEMENT_BODY_MAX_LENGTH,
  setTeamStatus,
  updateCompetition,
  updateCompetitionSchedule,
  updateCompetitionStatus,
  updateTeamStatus,
} from "./server/admin";

export {
  MAX_ADMIN_VALUATION_CASH_CENTS,
  clearAdminValuationPortfolio,
  createAdminValuationPosition,
  getAdminValuationPortfolio,
  setAdminValuationCash,
} from "./server/admin-valuation";

export {
  MAX_ADMIN_TRADING_CASH_CENTS,
  getAdminTradingTeamId,
  resetAdminTradingAccount,
  setAdminTradingCash,
} from "./server/admin-trading";

export {
  DISPLAY_NAME_MAX_LENGTH,
  normalizeDisplayName,
  updateDisplayName,
} from "./server/display-name";

export {
  addToWatchlist,
  getWatchlist,
  listWatchlist,
  watchlistSymbolsFor,
  removeFromWatchlist,
} from "./server/watchlist";
export type { WatchlistChangeInput } from "./server/watchlist";

export type {
  AdminValuationPortfolio,
  AdminValuationPosition,
  AdminValuationSummary,
  CreateAdminValuationPositionInput,
  SetAdminValuationCashInput,
} from "./backtest-contracts";

export {
  calculatePortfolio,
  competitionPhaseFor,
  getCompetitionSummary,
  getDashboard,
  recordPortfolioSnapshot,
  ensureWeekBaselines,
  getLeaderboard,
  getOrderByIdempotencyKey,
  getTeamHoldings,
  getTeamSummary,
  listActivity,
  listOrders,
  listOrdersForExport,
  getTeamHistoryForExport,
  MAX_EXPORTED_ORDERS,
  readRealizedGains,
} from "./server/queries";
export type { DashboardOptions, RealizedGains } from "./server/queries";
export { getWrapped, publishWrapped } from "./server/wrapped";

export {
  QUOTE_DELAY_MINUTES,
  QUOTE_RANGE_CONFIG,
  QUOTE_RANGES,
  DeterministicMarketDataProvider,
  YahooFinanceMarketDataProvider,
  getMarketDataProvider,
  getQuote,
  getQuoteHistory,
  listQuotes,
  listQuotesForSymbols,
  refreshQuotesFor,
  MARKET_SYMBOL_PATTERN,
  normalizeMarketSymbol,
  getPopularInstruments,
  refreshAllQuotes,
  refreshMissingQuotes,
  refreshQuote,
  requireQuote,
  searchInstruments,
  searchMarketInstruments,
  setMarketDataProvider,
  withBuyRules,
} from "./server/quotes";

export type {
  InstrumentSearchResult,
} from "./contracts";

export type {
  MarketDataProvider,
  MarketInstrument,
} from "./server/quotes";

export { placeOrder, replayOrder } from "./server/trading";
export type { FillOptions } from "./server/trading";

export {
  cancelWorkingOrder,
  getTeamReservations,
  listWorkingOrders,
  listWorkingOrdersForUser,
  placeWorkingOrder,
  workingOrderLabel,
} from "./server/working-orders";

export {
  hasOpenWorkingOrders,
  runWorkingOrders,
  runWorkingOrdersIfDue,
} from "./server/working-order-engine";
export type { WorkingOrderRunReport } from "./server/working-order-engine";

export { MAX_OPEN_WORKING_ORDERS_PER_TEAM, MAX_ORDER_PRICE_CENTS } from "./order-math";
export { workingOrderExpiresAt } from "./market-calendar";
export {
  readReservations,
  workingOrderTriggered,
  workingOrdersAvailableTo,
} from "./server/working-order-book";

export {
  FEEDBACK_SUBMISSIONS_PER_MINUTE,
  MAX_FEEDBACK_LIST_LIMIT,
  listFeedback,
  submitFeedback,
} from "./server/feedback";
export type { ListFeedbackOptions, SubmitFeedbackInput } from "./server/feedback";

export {
  assertLedgerReconciles,
  assertTeamLedgerReconciles,
  reconcileLedgers,
} from "./server/db";
