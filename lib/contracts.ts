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

/**
 * What kind of instrument a symbol is. Crypto trades in fixed lots: one
 * simulator "unit" of a crypto instrument is `lotSize` tokens, and every
 * price, quantity, and ledger amount for it is per lot. That keeps the
 * whole-number money math identical for every asset class.
 */
export type AssetClass = "STOCK" | "ETF" | "CRYPTO";

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

/**
 * Feedback is about either the public website (lubancanada.com) or this
 * simulator. The sender is the signed-in account, so there is no email field.
 */
export type FeedbackTopic = "WEBSITE" | "SIMULATOR";
/** Where it was sent from: the header button or the standalone /feedback page. */
export type FeedbackSource = "header" | "page";

export const FEEDBACK_TOPICS: readonly FeedbackTopic[] = ["WEBSITE", "SIMULATOR"];
export const FEEDBACK_SOURCES: readonly FeedbackSource[] = ["header", "page"];
/** Counted in characters after trimming. */
export const FEEDBACK_MIN_LENGTH = 5;
export const FEEDBACK_MAX_LENGTH = 2000;

export function isFeedbackTopic(value: unknown): value is FeedbackTopic {
  return FEEDBACK_TOPICS.includes(value as FeedbackTopic);
}

/** One submission as platform administrators review it. */
export interface FeedbackItem {
  id: string;
  topic: FeedbackTopic;
  message: string;
  source: FeedbackSource;
  createdAt: string;
  userId: string;
  userName: string;
  userEmail: string;
  /** The sender's team when they sent it; null for no team or a removed one. */
  teamId: string | null;
  teamName: string | null;
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
  /**
   * Whether the listing exchange's regular session was open when the quote
   * was fetched. Providers fail closed: unknown session data reports false.
   */
  marketOpen: boolean;
  /** Regular-session close for an open market; null when unknown or closed. */
  marketClosesAt: string | null;
  /** Next or current regular-session open when known; otherwise null. */
  marketOpensAt: string | null;
  /** Missing means STOCK (quotes produced before asset classes existed). */
  assetClass?: AssetClass;
  /** Tokens per unit for crypto (e.g. 0.0001 BTC); 1 for stocks and ETFs. */
  lotSize?: number;
  /**
   * Set when this instrument may not trade right now even though a price is
   * known, e.g. a crypto pair that failed the data-quality checks. Holdings
   * are still valued at this quote's price.
   */
  tradingHaltReason?: string | null;
}

export interface InstrumentSearchResult {
  symbol: string;
  name: string;
  exchange: string;
  sector: string;
  /** Missing or "Other" when the feed gives no industry. */
  industry?: string;
  listingCurrency: "CAD" | "USD";
  /** Missing means STOCK. */
  assetClass?: AssetClass;
}

/** A titled group of suggestions shown before the person types anything. */
export interface PopularSection {
  title: string;
  results: InstrumentSearchResult[];
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
  /** CUSTOM when the request named its own from/to dates. */
  range: QuoteRange | "CUSTOM";
  interval: string;
  /** The requested custom window (YYYY-MM-DD, inclusive), when there was one. */
  from?: string;
  to?: string;
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
  assetClass?: AssetClass;
  lotSize?: number;
  /** Shares (lots) held back for the team's waiting sells. */
  reservedQuantity?: number;
  /** Map grouping. "Unclassified" when the feed gives no sector. */
  sector: string;
  /** Map grouping within a sector. "Other" when the feed gives none. */
  industry: string;
  /** Change since the previous close for the whole position, in CAD cents. */
  dayChangeCents: number;
  /** The listing's change since the previous close, in percent. */
  dayChangePercent: number;
}

/**
 * One team's holdings for the portfolio map. Hosts and platform admins can
 * read any team's; everyone else only their own.
 */
export interface TeamHoldingsView {
  teamId: string;
  teamName: string;
  asOf: string;
  cashCents: number;
  totalValueCents: number;
  holdings: HoldingView[];
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
  /** Cash set aside for waiting buys (already left out of buying power). */
  reservedCashCents: number;
  /** Gain or loss on shares still held: market value minus their cost. */
  unrealizedGainCents: number;
  /** Gain or loss locked in by sells, each against the average cost then. */
  realizedGainCents: number;
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
  /**
   * For a sell, what it locked in: proceeds minus the average cost of the
   * shares sold. Null for buys, and left out where it was not worked out.
   */
  realizedGainCents?: number | null;
}

/** Most symbols one team can watch at once. */
export const MAX_WATCHLIST_ITEMS = 20;

/**
 * One symbol on a team's shared watchlist, priced like the rest of the
 * dashboard. quote is null when no price could be found for it right now.
 */
export interface WatchlistItemView {
  symbol: string;
  name: string;
  exchange: string;
  listingCurrency: "CAD" | "USD";
  assetClass: AssetClass;
  addedByName: string | null;
  addedAt: string;
  quote: Quote | null;
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
    | "MEMBER_JOINED"
    | "WORKING_ORDER_PLACED"
    | "WORKING_ORDER_CANCELLED"
    | "WORKING_ORDER_EXPIRED";
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
  /**
   * Set when portfolioHistory holds only the points after this instant (plus
   * the live value at the end), because the browser said it had the rest.
   */
  portfolioHistoryAfter?: string | null;
  recentOrders: OrderView[];
  recentActivity: ActivityItem[];
  leaderboard: LeaderboardRow[];
  availableSymbols: Quote[];
  /** The portfolio's open waiting orders, newest first. */
  workingOrders: WorkingOrderView[];
  /** Whether this person may place limit, stop loss, and take profit orders. */
  workingOrdersEnabled: boolean;
  /** The portfolio's shared watchlist, oldest first. Empty without a portfolio. */
  watchlist: WatchlistItemView[];
  serverTime: string;
}

export interface PlaceOrderInput {
  actorUserId: string;
  symbol: string;
  side: TradeSide;
  quantity: number;
  idempotencyKey: string;
  /** Optional exits attached to a market buy (a bracket). */
  bracket?: BracketInput;
}

/**
 * Orders that wait for a price. Take profit is a limit sell with a clearer
 * name; a stop loss becomes a market sell once the price falls to it, so it
 * can fill below the stop when the price gaps down, as it would in real life.
 */
export type WorkingOrderType = "LIMIT" | "STOP_LOSS" | "TAKE_PROFIT";

/**
 * PENDING_PARENT: a bracket exit waiting for its buy to fill.
 * WORKING: watching the price. The rest are final.
 */
export type WorkingOrderStatus =
  | "PENDING_PARENT"
  | "WORKING"
  | "FILLED"
  | "CANCELLED"
  | "EXPIRED";

/** DAY ends at the next market close; GTC lasts until cancelled or the competition ends. */
export type TimeInForce = "DAY" | "GTC";

/**
 * Optional exits for a buy. Each is a price per share (per lot for crypto)
 * in the listing's currency; either or both may be left out. When one fills,
 * the other is cancelled.
 */
export interface BracketInput {
  takeProfitCents?: number | null;
  stopLossCents?: number | null;
  timeInForce?: TimeInForce;
}

export interface PlaceWorkingOrderInput {
  actorUserId: string;
  symbol: string;
  side: TradeSide;
  orderType: WorkingOrderType;
  quantity: number;
  /** Price per share (per lot for crypto) in the listing's currency. */
  triggerPriceCents: number;
  timeInForce: TimeInForce;
  idempotencyKey: string;
  /** Only for a limit buy. */
  bracket?: BracketInput;
}

export interface WorkingOrderView {
  id: string;
  teamId: string;
  actorUserId: string;
  actorName: string;
  symbol: string;
  side: TradeSide;
  orderType: WorkingOrderType;
  quantity: number;
  triggerPriceCents: number;
  listingCurrency: "CAD" | "USD";
  assetClass: AssetClass;
  /** Tokens per lot for crypto; 1 for stocks and ETFs. */
  lotSize: number;
  reservedCashCents: number;
  timeInForce: TimeInForce;
  expiresAt: string | null;
  status: WorkingOrderStatus;
  statusReason: string | null;
  parentId: string | null;
  ocoGroupId: string | null;
  filledOrderId: string | null;
  createdAt: string;
  updatedAt: string;
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

/** Empties the authenticated administrator's private test portfolio. */
export interface ResetAdminTradingAccountInput {
  actorUserId: string;
  /** The cash to start again with; defaults to the cash it was funded with. */
  cashCents?: number;
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
