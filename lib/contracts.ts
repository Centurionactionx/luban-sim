/**
 * Shared, JSON-safe contracts for the simulator UI and route handlers.
 * Monetary values are integer cents. Share quantities are whole integers.
 */

export type UserRole = "student" | "host" | "platform_admin";
export type UserStatus = "active" | "suspended" | "deleted";
export type AuthMode = "demo" | "managed";
export type CompetitionStatus = "draft" | "active" | "paused" | "ended";

/**
 * The competition's effective state, derived from the stored status plus the
 * wall clock: an "active" competition is only "open" for trading between its
 * scheduled start and end. Derived at read time — no scheduler process needed,
 * so it works identically in a long-lived dev server and on serverless.
 */
export type CompetitionPhase =
  | "draft"
  | "scheduled"
  | "open"
  | "paused"
  | "ended";
export type TeamStatus = "active" | "frozen" | "disqualified";
export type TradeSide = "BUY" | "SELL";
export type OrderStatus = "FILLED" | "REJECTED";
export type MarketDataSource = "YAHOO_FINANCE" | "LUBAN_SIMULATED";
export type QuoteRange = "1D" | "5D" | "1M" | "3M";

export interface DemoUser {
  id: string;
  name: string;
  role: UserRole;
  teamId: string | null;
  teamName: string | null;
  initials: string;
}

export interface SessionUser extends DemoUser {
  email: string;
  status: UserStatus;
}

/**
 * Hosts and platform administrators may run competitions. Platform
 * administrators additionally manage accounts and invitations for every role.
 */
export function canHostCompetitions(role: UserRole): boolean {
  return role === "host" || role === "platform_admin";
}

export type InvitationState = "active" | "used" | "revoked" | "expired";

export interface InvitationSummary {
  id: string;
  role: UserRole;
  state: InvitationState;
  email: string | null;
  invitedName: string | null;
  teamId: string | null;
  teamName: string | null;
  competitionId: string | null;
  createdByName: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  usedAt: string | null;
  usedByName: string | null;
}

/** Returned once at creation time; the raw token is never stored or listed. */
export interface CreatedInvitation {
  invitation: InvitationSummary;
  token: string;
  joinPath: string;
}

/** Safe to show to an unauthenticated visitor holding an invitation link. */
export interface InvitationPreview {
  state: InvitationState;
  role: UserRole;
  invitedName: string | null;
  maskedEmail: string | null;
  teamName: string | null;
  competitionName: string | null;
  expiresAt: string;
}

export interface CreateInvitationInput {
  actorUserId: string;
  role: UserRole;
  teamId?: string | null;
  email?: string | null;
  invitedName?: string | null;
  expiresInHours?: number;
}

export interface AuthAuditEventView {
  id: string;
  type: string;
  actorName: string | null;
  subjectName: string | null;
  detail: string;
  createdAt: string;
}

/** One row of the admin user-management list. */
export interface AccountView {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: Exclude<UserStatus, "deleted">;
  teamId: string | null;
  teamName: string | null;
  isManaged: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  /** Filled orders attributed to this user (locks hard deletion). */
  orderCount: number;
}

export interface CompetitionSummary {
  id: string;
  name: string;
  status: CompetitionStatus;
  /** Effective state right now; trading is possible only while "open". */
  phase: CompetitionPhase;
  /** True exactly when phase is "open". */
  tradingOpen: boolean;
  baseCurrency: "CAD";
  startingCashCents: number;
  startsAt: string;
  endsAt: string;
}

export interface TeamSummary {
  id: string;
  name: string;
  status: TeamStatus;
  memberNames: string[];
  version: number;
}

export interface Quote {
  symbol: string;
  name: string;
  exchange: string;
  sector: string;
  listingCurrency: "CAD" | "USD";
  priceCents: number;
  priceCadCents: number;
  previousCloseCents: number;
  previousCloseCadCents: number;
  changeCents: number;
  changePercent: number;
  fxRateBasisPoints: number;
  asOf: string;
  source: MarketDataSource;
  sourceUrl: string | null;
  isStale: boolean;
}

export interface InstrumentSearchResult {
  symbol: string;
  name: string;
  exchange: string;
  sector: string;
  listingCurrency: "CAD" | "USD";
}

export interface QuoteHistoryPoint {
  at: string;
  openCents: number | null;
  highCents: number | null;
  lowCents: number | null;
  closeCents: number;
  volume: number | null;
}

export interface QuoteHistory {
  symbol: string;
  range: QuoteRange;
  interval: string;
  listingCurrency: "CAD" | "USD";
  exchangeTimeZone: string;
  points: QuoteHistoryPoint[];
  asOf: string;
  fetchedAt: string;
  source: MarketDataSource;
  sourceUrl: string | null;
  isStale: boolean;
}

export interface HoldingView {
  symbol: string;
  name: string;
  exchange: string;
  listingCurrency: "CAD" | "USD";
  quantity: number;
  averageCostCents: number;
  currentPriceCents: number;
  currentPriceCadCents: number;
  marketValueCents: number;
  costBasisCents: number;
  gainLossCents: number;
  gainLossPercent: number;
  portfolioWeightPercent: number;
  quoteAsOf: string;
}

export interface PortfolioPoint {
  at: string;
  valueCents: number;
}

export interface PortfolioSummary {
  cashCents: number;
  holdingsValueCents: number;
  totalValueCents: number;
  startingValueCents: number;
  totalReturnCents: number;
  totalReturnPercent: number;
  dayChangeCents: number;
  dayChangePercent: number;
  buyingPowerCents: number;
  asOf: string;
}

export interface OrderView {
  id: string;
  idempotencyKey: string;
  teamId: string;
  teamName: string;
  actorUserId: string;
  actorName: string;
  symbol: string;
  side: TradeSide;
  quantity: number;
  fillPriceCents: number;
  fillPriceCadCents: number;
  grossCents: number;
  status: OrderStatus;
  createdAt: string;
}

export interface ActivityItem {
  id: string;
  type:
    | "ORDER_FILLED"
    | "COMPETITION_STATUS_CHANGED"
    | "COMPETITION_SCHEDULE_CHANGED"
    | "TEAM_STATUS_CHANGED"
    | "TEAM_CASH_ADJUSTED"
    | "TEAM_CREATED"
    | "MEMBER_JOINED";
  title: string;
  detail: string;
  actorUserId: string | null;
  actorName: string;
  teamId: string | null;
  teamName: string | null;
  createdAt: string;
}

export interface LeaderboardRow {
  rank: number;
  teamId: string;
  teamName: string;
  teamStatus: TeamStatus;
  totalValueCents: number;
  returnCents: number;
  returnPercent: number;
  tradeCount: number;
  isCurrentTeam: boolean;
}

export interface Leaderboard {
  competitionId: string;
  asOf: string;
  rows: LeaderboardRow[];
}

export interface Dashboard {
  currentUser: SessionUser;
  competition: CompetitionSummary;
  team: TeamSummary | null;
  portfolio: PortfolioSummary | null;
  holdings: HoldingView[];
  portfolioHistory: PortfolioPoint[];
  recentOrders: OrderView[];
  recentActivity: ActivityItem[];
  leaderboard: LeaderboardRow[];
  availableSymbols: Quote[];
  serverTime: string;
}

export interface PlaceOrderInput {
  actorUserId: string;
  symbol: string;
  side: TradeSide;
  quantity: number;
  idempotencyKey: string;
}

export interface TradeReceipt {
  order: OrderView;
  cashAfterCents: number;
  holdingQuantityAfter: number;
  portfolioVersion: number;
  duplicate: boolean;
}

export interface AdminTeamSummary {
  id: string;
  name: string;
  status: TeamStatus;
  memberNames: string[];
  cashCents: number;
  totalValueCents: number;
  returnCents: number;
  returnPercent: number;
  tradeCount: number;
  version: number;
}

export interface AdminOverview {
  competition: CompetitionSummary;
  teams: AdminTeamSummary[];
  recentActivity: ActivityItem[];
  generatedAt: string;
}

export interface LedgerReconciliation {
  teamId: string;
  teamName: string;
  cashCents: number;
  ledgerBalanceCents: number;
  differenceCents: number;
  reconciled: boolean;
}

export interface UpdateCompetitionStatusInput {
  actorUserId: string;
  status: CompetitionStatus;
}

export interface UpdateCompetitionScheduleInput {
  actorUserId: string;
  startsAt?: string;
  endsAt?: string;
  startingCashCents?: number;
}

export interface UpdateTeamStatusInput {
  actorUserId: string;
  teamId: string;
  status: TeamStatus;
}

export interface CreateCompetitionTeamInput {
  actorUserId: string;
  name: string;
}

export interface RenameCompetitionTeamInput {
  actorUserId: string;
  teamId: string;
  name: string;
}

export interface RemoveCompetitionTeamInput {
  actorUserId: string;
  teamId: string;
}

export interface SetTeamCashInput {
  actorUserId: string;
  teamId: string;
  cashCents: number;
}

/** Sets the authenticated platform administrator's private trading cash. */
export interface SetAdminTradingCashInput {
  actorUserId: string;
  cashCents: number;
}

export interface AdminTradingCashResult {
  teamId: string;
  cashCents: number;
  portfolioVersion: number;
  created: boolean;
}

export interface SerializedAppError {
  name: "AppError";
  code: string;
  message: string;
  status: number;
  details?: Record<string, unknown>;
}
