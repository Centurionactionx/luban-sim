export * from "./contracts";
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
  listAccounts,
  setAccountRole,
  setAccountStatus,
  setAccountTeam,
} from "./server/account-management";

export type { ManagedResolution } from "./server/accounts";

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
  setAdminTradingCash,
} from "./server/admin-trading";

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
  getLeaderboard,
  getOrderByIdempotencyKey,
  getTeamSummary,
  listActivity,
  listOrders,
} from "./server/queries";

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
  MARKET_SYMBOL_PATTERN,
  normalizeMarketSymbol,
  refreshAllQuotes,
  refreshMissingQuotes,
  refreshQuote,
  requireQuote,
  searchInstruments,
  searchMarketInstruments,
  setMarketDataProvider,
} from "./server/quotes";

export type {
  InstrumentSearchResult,
} from "./contracts";

export type {
  MarketDataProvider,
  MarketInstrument,
} from "./server/quotes";

export { placeOrder, replayOrder } from "./server/trading";

export {
  assertLedgerReconciles,
  assertTeamLedgerReconciles,
  reconcileLedgers,
} from "./server/db";
