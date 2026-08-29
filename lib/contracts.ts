/**
 * Shared, JSON-safe contracts for the simulator UI and route handlers.
 * Monetary values are integer cents. Share quantities are whole integers.
 */

export type UserRole = "student" | "host";
export type CompetitionStatus = "draft" | "active" | "paused" | "ended";
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
}

export interface CompetitionSummary {
  id: string;
  name: string;
  status: CompetitionStatus;
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

export interface UpdateTeamStatusInput {
  actorUserId: string;
  teamId: string;
  status: TeamStatus;
}

export interface SetTeamCashInput {
  actorUserId: string;
  teamId: string;
  cashCents: number;
}

export interface SerializedAppError {
  name: "AppError";
  code: string;
  message: string;
  status: number;
  details?: Record<string, unknown>;
}
