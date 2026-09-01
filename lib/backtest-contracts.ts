import type { MarketDataSource } from "./contracts";

/** A real historical market close resolved for a requested calendar date. */
export interface HistoricalMarketPrice {
  symbol: string;
  requestedDate: string;
  sessionDate: string;
  sessionAt: string;
  listingCurrency: "CAD" | "USD";
  /** Contemporaneous, pre-later-splits close per original share. */
  closeCents: number;
  closeCadCents: number;
  fxRateBasisPoints: number;
  fxAsOf: string;
  /** Share multiplier from splits after the purchase session through today. */
  splitMultiplier: number;
  source: MarketDataSource;
  sourceUrl: string | null;
}

export interface AdminValuationPosition {
  id: string;
  symbol: string;
  name: string;
  exchange: string;
  listingCurrency: "CAD" | "USD";
  requestedDate: string;
  sessionDate: string;
  sessionAt: string;
  originalQuantity: number;
  currentQuantity: number;
  splitMultiplier: number;
  purchasePriceCents: number;
  purchasePriceCadCents: number;
  historicalFxRateBasisPoints: number;
  costBasisCents: number;
  currentPriceCents: number;
  currentPriceCadCents: number;
  currentValueCents: number;
  gainLossCents: number;
  returnPercent: number;
  currentQuoteAsOf: string;
  currentQuoteIsStale: boolean;
  source: MarketDataSource;
  sourceUrl: string | null;
  createdAt: string;
}

export interface AdminValuationSummary {
  positionCount: number;
  /** Configured cash before any historical test purchases. */
  startingCashCents: number;
  /** Starting cash that has not been committed to historical purchases. */
  availableCashCents: number;
  costBasisCents: number;
  /** Current market value of the test positions, excluding available cash. */
  holdingsValueCents: number;
  /** Available cash plus the current market value of the test positions. */
  totalValueCents: number;
  /** @deprecated Compatibility alias for holdingsValueCents. */
  currentValueCents: number;
  gainLossCents: number;
  returnPercent: number;
  asOf: string;
  hasStaleQuotes: boolean;
}

export interface AdminValuationPortfolio {
  summary: AdminValuationSummary;
  positions: AdminValuationPosition[];
  refreshIntervalSeconds: number;
}

export interface CreateAdminValuationPositionInput {
  actorUserId: string;
  idempotencyKey: string;
  symbol: string;
  quantity: number;
  purchaseDate: string;
}

export interface SetAdminValuationCashInput {
  actorUserId: string;
  cashCents: number;
}
