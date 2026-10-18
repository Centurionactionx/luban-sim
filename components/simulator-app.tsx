"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  ActivityItem,
  AdminOverview,
  AuthMode,
  CompetitionSummary,
  Dashboard,
  DemoUser,
  HoldingView,
  InstrumentSearchResult,
  OrderView,
  PopularSection,
  LeaderboardRow,
  PortfolioPoint,
  PortfolioSummary,
  Quote,
  QuoteHistory,
  QuoteRange,
  SessionUser,
  TeamHoldingsView,
  TeamSummary,
  TimeInForce,
  TradeAction,
  TradeSide,
  WatchlistItemView,
  WorkingOrderType,
  WorkingOrderView,
} from "@/lib/contracts";
import { MAX_WATCHLIST_ITEMS } from "@/lib/contracts";
import { centsToDecimal, toCsv } from "@/lib/csv";
import {
  cryptoTokenSymbol,
  formatTokenQuantity,
  lotExponentFromSize,
  unitWord,
} from "@/lib/lots";
import {
  type ApiErrorShape,
  extractError,
  orderKeyOutlivesFailure,
  readJson,
} from "@/lib/api-client";
import { workingOrderExpiresAt } from "@/lib/market-calendar";
import {
  MAX_OPEN_WORKING_ORDERS_PER_TEAM,
  MAX_ORDER_PRICE_CENTS,
  MAX_ORDER_QUANTITY,
  MAX_POSITION_PERCENT,
  positionRoomCents,
  priceInputToCents,
  reservedCadCentsPerUnit,
} from "@/lib/order-math";
import {
  DEFAULT_QUOTE_INTERVAL,
  EARLIEST_HISTORY_DATE,
  QUOTE_INTERVALS,
  QUOTE_INTERVAL_LABELS,
  allowedIntervals,
  customHistoryWindow,
  isIntradayInterval,
  presetHistoryWindow,
  resolveInterval,
  torontoToday,
  type QuoteInterval,
} from "@/lib/history-options";
import {
  DISPLAY_TIME_ZONE,
  isoToZonedInputValue,
  zonedInputValueToIso,
} from "@/lib/time";
import {
  allMarketsClosed,
  IDLE_SYNC_INTERVAL_MS,
  MARKET_REFRESH_INTERVAL_MS,
  TEAM_SYNC_INTERVAL_MS,
} from "@/lib/market-config";
import {
  ArrowIcon,
  BellIcon,
  BookIcon,
  ChatIcon,
  ChevronDownIcon,
  DownloadIcon,
  PlusIcon,
  HistoryIcon,
  StarIcon,
  CalendarIcon,
  CloseIcon,
  ExpandIcon,
  FlaskIcon,
  InfoIcon,
  LockIcon,
  PauseIcon,
  PlayIcon,
  PulseIcon,
  RefreshIcon,
  SearchIcon,
  TreemapIcon,
  UserIcon,
  UsersIcon,
} from "./simulator-icons";
import { AnnouncementBanner, AnnouncementForm } from "./announcement";
import { DisplayNamePrompt, useNamePromptLater } from "./display-name-prompt";
import { FeedbackButton } from "./feedback-button";
import { LubanMark, LubanWordmark } from "./luban-logo";
import summaryStyles from "./portfolio-summary.module.css";
import { ThemeToggle } from "./theme-toggle";
import { WrappedBanner, WrappedPublishForm } from "./wrapped-publish";

// Only shown inside its dialog, so its code downloads when first opened.
const PortfolioMap = dynamic(() => import("./portfolio-map").then((m) => m.PortfolioMap));

export type DashboardPayload = Dashboard & {
  session: {
    user: SessionUser;
    demoUsers: DemoUser[];
  };
};

type RailSectionId = "watchlist" | "presence" | "leaderboard";

/** What the portfolio map dialog shows: this portfolio, or a team a host opened. */
type MapDialogView =
  | { kind: "own" }
  | {
      kind: "team";
      teamId: string;
      teamName: string;
      status: "loading" | "ready" | "error";
      holdings: TeamHoldingsView | null;
      error: string;
    };

const INITIAL_RAIL_SECTIONS: Record<RailSectionId, boolean> = {
  watchlist: true,
  presence: true,
  leaderboard: true,
};

type OrderResult = {
  ok: true;
  order: {
    id: string;
    side: TradeSide;
    symbol: string;
    quantity: number;
    fillPriceCadCents: number;
    status: "FILLED" | "REJECTED";
  };
  portfolioVersion: number;
  duplicate: boolean;
};

type QuoteHistoryPayload = {
  quote?: Quote;
  history?: QuoteHistory;
} & ApiErrorShape;

type ConnectionState = "connecting" | "connected" | "reconnecting";

type ChartPoint = PortfolioPoint & {
  openCents?: number | null;
  highCents?: number | null;
  lowCents?: number | null;
  volume?: number | null;
};
type TicketStatus =
  | { kind: "idle"; message: string }
  | { kind: "working"; message: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string }
  | { kind: "blocked"; message: string };

const FIXED_NOW = "2026-08-28T14:20:00.000Z";
const MAX_TEAM_CASH_CENTS = 100_000_000_000_000;

const fallbackUsers: DemoUser[] = [
  {
    id: "alex",
    name: "Johnny",
    role: "student",
    teamId: "northstar",
    teamName: "Northstar Capital",
    initials: "AC",
  },
  {
    id: "maya",
    name: "Menon",
    role: "student",
    teamId: "northstar",
    teamName: "Northstar Capital",
    initials: "MS",
  },
  {
    id: "jordan",
    name: "Radin",
    role: "student",
    teamId: "northstar",
    teamName: "Northstar Capital",
    initials: "JB",
  },
  {
    id: "host",
    name: "Joe (Host)",
    role: "host",
    teamId: null,
    teamName: null,
    initials: "SH",
  },
];

const fallbackQuotes: Quote[] = [
  {
    symbol: "SHOP.TO",
    name: "Shopify Inc.",
    exchange: "TSX",
    sector: "Technology",
    listingCurrency: "CAD",
    priceCents: 15840,
    priceCadCents: 15840,
    previousCloseCents: 15610,
    previousCloseCadCents: 15610,
    changeCents: 230,
    changePercent: 1.47,
    fxRateBasisPoints: 10000,
    asOf: FIXED_NOW,
    source: "LUBAN_SIMULATED",
    sourceUrl: null,
    isStale: true,
    marketOpen: false,
    marketClosesAt: null,
    marketOpensAt: null,
  },
  {
    symbol: "RY.TO",
    name: "Royal Bank of Canada",
    exchange: "TSX",
    sector: "Financials",
    listingCurrency: "CAD",
    priceCents: 21765,
    priceCadCents: 21765,
    previousCloseCents: 21590,
    previousCloseCadCents: 21590,
    changeCents: 175,
    changePercent: 0.81,
    fxRateBasisPoints: 10000,
    asOf: FIXED_NOW,
    source: "LUBAN_SIMULATED",
    sourceUrl: null,
    isStale: true,
    marketOpen: false,
    marketClosesAt: null,
    marketOpensAt: null,
  },
  {
    symbol: "AAPL",
    name: "Apple Inc.",
    exchange: "NASDAQ",
    sector: "Technology",
    listingCurrency: "USD",
    priceCents: 23845,
    priceCadCents: 32429,
    previousCloseCents: 23610,
    previousCloseCadCents: 32110,
    changeCents: 235,
    changePercent: 1,
    fxRateBasisPoints: 13600,
    asOf: FIXED_NOW,
    source: "LUBAN_SIMULATED",
    sourceUrl: null,
    isStale: true,
    marketOpen: false,
    marketClosesAt: null,
    marketOpensAt: null,
  },
];

const fallbackHoldings: HoldingView[] = [];

const fallbackPortfolio: PortfolioSummary = {
  cashCents: 10000000,
  holdingsValueCents: 0,
  totalValueCents: 10000000,
  startingValueCents: 10000000,
  totalReturnCents: 0,
  totalReturnPercent: 0,
  dayChangeCents: 0,
  dayChangePercent: 0,
  buyingPowerCents: 10000000,
  reservedCashCents: 0,
  shortLiabilityCents: 0,
  unrealizedGainCents: 0,
  realizedGainCents: 0,
  asOf: FIXED_NOW,
};

const fallbackHistory: PortfolioPoint[] = [
  { at: "2026-08-22T14:20:00.000Z", valueCents: 0 },
  { at: "2026-08-23T14:20:00.000Z", valueCents: 0 },
  { at: "2026-08-24T14:20:00.000Z", valueCents: 0 },
  { at: "2026-08-25T14:20:00.000Z", valueCents: 0 },
  { at: "2026-08-26T14:20:00.000Z", valueCents: 0 },
  { at: "2026-08-27T14:20:00.000Z", valueCents: 0 },
  { at: "2026-08-28T14:20:00.000Z", valueCents: 0 },
];

const fallbackActivity: ActivityItem[] = [
  {
    id: "activity-1",
    type: "MEMBER_JOINED",
    title: "Northstar Capital is ready",
    detail: "Johnny, Menon, and Radin joined the shared team portfolio.",
    actorUserId: "alex",
    actorName: "Johnny",
    teamId: "northstar",
    teamName: "Northstar Capital",
    createdAt: "2026-08-23T14:20:00.000Z",
  },
];

const fallbackLeaderboard: LeaderboardRow[] = [
  {
    rank: 1,
    teamId: "aurora-fund",
    teamName: "Aurora Fund",
    teamStatus: "active",
    totalValueCents: 10000000,
    returnCents: 0,
    returnPercent: 0,
    tradeCount: 0,
    isCurrentTeam: false,
  },
  {
    rank: 2,
    teamId: "cedar-street",
    teamName: "Cedar Street",
    teamStatus: "active",
    totalValueCents: 10000000,
    returnCents: 0,
    returnPercent: 0,
    tradeCount: 0,
    isCurrentTeam: false,
  },
  {
    rank: 3,
    teamId: "maple-alpha",
    teamName: "Maple Alpha",
    teamStatus: "active",
    totalValueCents: 10000000,
    returnCents: 0,
    returnPercent: 0,
    tradeCount: 0,
    isCurrentTeam: false,
  },
  {
    rank: 4,
    teamId: "northstar",
    teamName: "Northstar Capital",
    teamStatus: "active",
    totalValueCents: 10000000,
    returnCents: 0,
    returnPercent: 0,
    tradeCount: 0,
    isCurrentTeam: true,
  },
];

const fallbackCompetition: CompetitionSummary = {
  id: "fall-2026",
  name: "Luban Fall Market Challenge",
  status: "active",
  phase: "open",
  tradingOpen: true,
  wrappedPublished: false,
  baseCurrency: "CAD",
  startingCashCents: 10000000,
  startsAt: "2026-08-24T14:20:00.000Z",
  endsAt: "2026-09-22T14:20:00.000Z",
};

const fallbackTeam: TeamSummary = {
  id: "northstar",
  name: "Northstar Capital",
  status: "active",
  memberNames: ["Johnny", "Menon", "Radin"],
  version: 0,
};

const fallbackDashboard: DashboardPayload = {
  currentUser: {
    ...fallbackUsers[0],
    email: "alex@demo.luban.org",
    status: "active",
  },
  competition: fallbackCompetition,
  announcement: null,
  team: fallbackTeam,
  portfolio: fallbackPortfolio,
  holdings: fallbackHoldings,
  portfolioHistory: fallbackHistory,
  recentOrders: [],
  recentActivity: fallbackActivity,
  leaderboard: fallbackLeaderboard,
  availableSymbols: fallbackQuotes,
  workingOrders: [],
  workingOrdersEnabled: false,
  watchlist: [],
  serverTime: FIXED_NOW,
  session: {
    user: { ...fallbackUsers[0], email: "alex@demo.luban.org", status: "active" },
    demoUsers: fallbackUsers,
  },
};

const emptyPortfolio: PortfolioSummary = {
  cashCents: 0,
  holdingsValueCents: 0,
  totalValueCents: 0,
  startingValueCents: 0,
  totalReturnCents: 0,
  totalReturnPercent: 0,
  dayChangeCents: 0,
  dayChangePercent: 0,
  buyingPowerCents: 0,
  reservedCashCents: 0,
  shortLiabilityCents: 0,
  unrealizedGainCents: 0,
  realizedGainCents: 0,
  asOf: FIXED_NOW,
};

const currency = new Intl.NumberFormat("en-CA", {
  style: "currency",
  currency: "CAD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const number = new Intl.NumberFormat("en-CA");
const MAX_SUGGESTIONS = 8;
/** The server's snapshot limit plus the start and live points. */
const PORTFOLIO_HISTORY_KEEP = 722;
// package.json's version; its minor number counts production releases.
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "";
const APP_COMMIT = process.env.NEXT_PUBLIC_APP_COMMIT ?? "";

const MAKER_LINKS = [
  {
    label: "GitHub",
    href: "https://github.com/Centurionactionx",
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path
          fill="currentColor"
          d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
        />
      </svg>
    ),
  },
  {
    label: "LinkedIn",
    href: "https://www.linkedin.com/in/joseph-wang-458a3625a/",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          fill="currentColor"
          d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z"
        />
      </svg>
    ),
  },
  {
    label: "Instagram",
    href: "https://www.instagram.com/joe.w.001/",
    icon: (
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" />
        <circle cx="12" cy="12" r="4.25" />
        <circle cx="17.6" cy="6.4" r="1.1" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
];
/** Hover box width (176px) plus its 10px gap from the line and an edge margin. */
// The step-by-step guide lives on the public site.
const SIM_GUIDE_URL = "https://lubancanada.com/sim-guide";
const CHART_TOOLTIP_SPACE_PX = 172;
const SUGGESTION_DELAY_MS = 250;
const POPULAR_CACHE_KEY = "luban:popular-picks";
const POPULAR_CACHE_TTL_MS = 10 * 60_000;

/**
 * Instant suggestions from listings the page already knows, ranked like a
 * search box: exact ticker, ticker prefix, name prefix, word prefix, then a
 * ticker that merely contains the text. Shown on the keystroke itself, before
 * the network answers.
 */
function rankLocalSuggestions(
  query: string,
  known: Iterable<InstrumentSearchResult>,
): InstrumentSearchResult[] {
  const needle = query.trim().toUpperCase();
  if (!needle) return [];
  const scored: Array<{ result: InstrumentSearchResult; score: number }> = [];
  for (const result of known) {
    const symbol = result.symbol.toUpperCase();
    const name = result.name.toUpperCase();
    const score =
      symbol === needle || symbol === `${needle}-CAD` || symbol === `${needle}.TO`
        ? 0
        : symbol.startsWith(needle)
          ? 1
          : name.startsWith(needle)
            ? 2
            : name.split(/[\s.,&()-]+/).some((word) => word.startsWith(needle))
              ? 3
              : needle.length >= 3 && symbol.includes(needle)
                ? 4
                : -1;
    if (score >= 0) scored.push({ result, score });
  }
  return scored
    .sort(
      (left, right) =>
        left.score - right.score ||
        left.result.symbol.length - right.result.symbol.length ||
        left.result.symbol.localeCompare(right.result.symbol),
    )
    .slice(0, MAX_SUGGESTIONS)
    .map(({ result }) => result);
}

function formatMoney(cents: number): string {
  return currency.format(cents / 100);
}

function formatScheduleInstant(iso: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  return date.toLocaleString("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: DISPLAY_TIME_ZONE,
  }) + " ET";
}

function parseCashDraft(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) return null;

  const [wholeDollars, fractionalDollars = ""] = normalized.split(".");
  const cents =
    Number(wholeDollars) * 100 + Number(fractionalDollars.padEnd(2, "0"));

  return Number.isSafeInteger(cents) &&
    cents >= 0 &&
    cents <= MAX_TEAM_CASH_CENTS
    ? cents
    : null;
}

function formatSignedMoney(cents: number): string {
  return `${cents >= 0 ? "+" : "−"}${formatMoney(Math.abs(cents))}`;
}

/** Cash that can go below zero: shows a minus sign instead of a plus. */
function formatSignedCash(cents: number): string {
  return cents < 0 ? `−${formatMoney(-cents)}` : formatMoney(cents);
}

function formatPercent(value: number): string {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}%`;
}

function formatTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat("en-CA", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: DISPLAY_TIME_ZONE,
  }).format(parsed);
}

function formatActivityTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "Recently";
  return new Intl.DateTimeFormat("en-CA", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: DISPLAY_TIME_ZONE,
  }).format(parsed);
}

/** Signs in as the default demo trader (demo mode only). */
function startDemoSession(): Promise<Response> {
  return fetch("/api/auth/demo-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: "alex" }),
  });
}

function createIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

function formatNativeMoney(cents: number, currency: "CAD" | "USD"): string {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

/**
 * Price of one whole token from a per-lot crypto price. Tiny coins are worth a
 * fraction of a cent, so values under $1 keep up to four significant figures
 * instead of rounding to "$0.00".
 */
function formatPerTokenMoney(
  lotCents: number,
  lotSize: number,
  currency: "CAD" | "USD",
): string {
  const perToken = lotCents / 100 / lotSize;
  return new Intl.NumberFormat(
    "en-CA",
    perToken >= 1
      ? { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }
      : {
          style: "currency",
          currency,
          minimumSignificantDigits: 2,
          maximumSignificantDigits: 4,
        },
  ).format(perToken);
}

/** Exact token amount for a whole number of crypto lots, e.g. "0.0003 BTC". */
function tokenAmountLabel(quantity: number, lotSize: number, symbol: string): string {
  return `${formatTokenQuantity(quantity, lotSize)} ${cryptoTokenSymbol(symbol)}`;
}

type TicketOrderType = "MARKET" | WorkingOrderType;

const ACTION_LABELS: Record<TradeAction, string> = {
  BUY: "Buy",
  SELL: "Sell",
  SHORT: "Short",
  COVER: "Buy to cover",
};

const ORDER_TYPE_LABELS: Record<TicketOrderType, string> = {
  MARKET: "Market",
  LIMIT: "Limit",
  STOP_LOSS: "Stop loss",
  TAKE_PROFIT: "Take profit",
};
const BUY_ORDER_TYPES: TicketOrderType[] = ["MARKET", "LIMIT"];
const SELL_ORDER_TYPES: TicketOrderType[] = ["MARKET", "LIMIT", "STOP_LOSS", "TAKE_PROFIT"];
const STALE_SNAPSHOT_MESSAGE =
  "Showing the last real market snapshot. Trading waits for a fresh quote.";
/** How long an order request may hang before the ticket offers a retry. */
const ORDER_REQUEST_TIMEOUT_MS = 20_000;

/** "Limit buy", "Stop loss", ...: how a waiting order is named everywhere. */
function workingOrderName(orderType: WorkingOrderType, side: TradeSide): string {
  if (orderType === "STOP_LOSS") return "Stop loss";
  if (orderType === "TAKE_PROFIT") return "Take profit";
  return side === "BUY" ? "Limit buy" : "Limit sell";
}

/**
 * A price typed into the ticket. Crypto prices are typed per whole token, like
 * the quote above the ticket, and stored per lot in whole cents, so they are
 * rounded in the trader's favour: down for buys and stops, up for sells at a
 * target. `cents` is null for text that isn't a price and 0 for a price below
 * one cent per lot; `rounded` says the stored price differs from the typed one.
 */
interface TicketPrice {
  cents: number | null;
  rounded: boolean;
}

function parseTicketPrice(
  value: string,
  isCrypto: boolean,
  lotSize: number,
  round: "down" | "up",
): TicketPrice {
  const options = {
    lotExponent: isCrypto ? lotExponentFromSize(lotSize) : 0,
    maxDecimals: isCrypto ? 10 : 2,
  };
  const cents = priceInputToCents(value, { ...options, round });
  if (cents === null || cents > MAX_ORDER_PRICE_CENTS) return { cents: null, rounded: false };
  const other = priceInputToCents(value, { ...options, round: round === "down" ? "up" : "down" });
  return { cents, rounded: other !== cents };
}

/** A per-share (per-lot) price as people read it: per token for crypto. */
function formatTicketPrice(
  cents: number,
  currency: "CAD" | "USD",
  isCrypto: boolean,
  lotSize: number,
): string {
  return isCrypto
    ? formatPerTokenMoney(cents, lotSize, currency)
    : formatNativeMoney(cents, currency);
}

function formatWorkingOrderPrice(order: WorkingOrderView): string {
  const isCrypto = order.assetClass === "CRYPTO";
  const price = formatTicketPrice(
    order.triggerPriceCents,
    order.listingCurrency,
    isCrypto,
    order.lotSize,
  );
  return isCrypto ? `${price} per ${cryptoTokenSymbol(order.symbol)}` : price;
}

function isPlatformAdminRole(dashboard: { currentUser: { role: string } }): boolean {
  return dashboard.currentUser.role === "platform_admin";
}

function activityStateLabel(type: ActivityItem["type"]): string {
  switch (type) {
    case "ORDER_FILLED":
      return "Filled";
    case "WORKING_ORDER_PLACED":
      return "Waiting";
    case "WORKING_ORDER_CANCELLED":
      return "Cancelled";
    case "WORKING_ORDER_EXPIRED":
      return "Expired";
    default:
      return "Logged";
  }
}

/**
 * A "?" that explains the control beside it (WCAG 1.4.13). It opens on hover,
 * focus, or a tap; the pointer can move onto the text without closing it; a
 * second tap, a tap elsewhere, leaving it, or Escape closes it.
 */
function HelpTip({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // Opened by a click or tap, rather than just hovered or focused: it then
  // stays open until a second press, a press elsewhere, or Escape.
  const pinned = useRef(false);
  // Where the bubble sits, relative to the "?": centred on it, but kept
  // 16px inside the window so it never runs off a narrow screen.
  const [bubbleLeft, setBubbleLeft] = useState<number | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const hide = () => {
    pinned.current = false;
    setOpen(false);
  };
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        pinned.current = false;
        setOpen(false);
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node)) {
        pinned.current = false;
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);
  const show = () => {
    const box = anchor.current?.getBoundingClientRect();
    if (box) {
      const viewport = document.documentElement.clientWidth;
      const width = Math.min(300, viewport - 32);
      const centred = box.left + box.width / 2 - width / 2;
      const left = Math.max(16, Math.min(centred, viewport - 16 - width));
      setBubbleLeft(left - box.left);
    }
    setOpen(true);
  };
  return (
    <span
      ref={anchor}
      className="help-tip"
      data-open={open}
      onMouseEnter={show}
      onMouseLeave={() => {
        if (!pinned.current) setOpen(false);
      }}
    >
      <button
        type="button"
        className="help-tip__button"
        aria-label={label}
        aria-describedby={id}
        onFocus={show}
        onClick={() => {
          if (pinned.current) {
            hide();
          } else {
            pinned.current = true;
            show();
          }
        }}
        onBlur={hide}
      >
        ?
      </button>
      <span
        className="help-tip__bubble"
        role="tooltip"
        id={id}
        style={bubbleLeft === null ? undefined : { left: bubbleLeft, transform: "none" }}
      >
        {children}
      </span>
    </span>
  );
}

function assetTagLabel(assetClass: Quote["assetClass"]): string | null {
  if (assetClass === "ETF") return "ETF";
  if (assetClass === "CRYPTO") return "Crypto";
  return null;
}

function marketSourceLabel(source: Quote["source"]): string {
  return source === "YAHOO_FINANCE" ? "Yahoo Finance" : "Test market data";
}

function formatChartTime(
  iso: string,
  range: QuoteRange | undefined,
  timeZone: string,
): string {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "—";
  if (range === "1D") {
    return new Intl.DateTimeFormat("en-CA", {
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    }).format(value);
  }
  return new Intl.DateTimeFormat("en-CA", {
    month: "short",
    day: "numeric",
    ...(range === "5D" ? { hour: "numeric" as const } : {}),
    timeZone,
  }).format(value);
}

function formatChartTooltipTime(iso: string, timeZone: string): string {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat("en-CA", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone,
  }).format(value);
}

function formatChartVolume(volume: number): string {
  return new Intl.NumberFormat("en-CA", {
    maximumFractionDigits: 0,
  }).format(volume);
}

type ChartStyle = "line" | "candle" | "bar";

const CHART_STYLES: { value: ChartStyle; label: string }[] = [
  { value: "line", label: "Line" },
  { value: "candle", label: "Candle" },
  { value: "bar", label: "Bar" },
];

type ChartClockParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

type ChartTickKind = "time" | "day" | "month" | "year";

const CHART_CLOCK_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function chartClockParts(iso: string, timeZone: string): ChartClockParts | null {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return null;
  let formatter = CHART_CLOCK_FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone,
    });
    CHART_CLOCK_FORMATTERS.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(value).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

function chartWeekKey(parts: ChartClockParts): string {
  const dayStart = Date.UTC(parts.year, parts.month - 1, parts.day);
  const daysSinceMonday = (new Date(dayStart).getUTCDay() + 6) % 7;
  return String(dayStart - daysSinceMonday * 86_400_000);
}

// Finest first: the axis uses the finest step that fits, like a trading
// terminal labelling every half hour on a wide 1D chart and every month on 3M.
const CHART_TICK_STEPS: {
  kind: ChartTickKind;
  key: (parts: ChartClockParts) => string;
}[] = [
  ...[15, 30, 60, 120].map((minutes) => ({
    kind: "time" as const,
    key: (parts: ChartClockParts) =>
      `${parts.year}-${parts.month}-${parts.day} ${Math.floor(
        (parts.hour * 60 + parts.minute) / minutes,
      )}`,
  })),
  {
    kind: "day",
    key: (parts) => `${parts.year}-${parts.month}-${parts.day}`,
  },
  { kind: "day", key: chartWeekKey },
  { kind: "month", key: (parts) => `${parts.year}-${parts.month}` },
  { kind: "year", key: (parts) => `${parts.year}` },
];

function formatChartTick(iso: string, kind: ChartTickKind, timeZone: string): string {
  return new Intl.DateTimeFormat(
    "en-CA",
    kind === "time"
      ? { hour: "numeric", minute: "2-digit", timeZone }
      : kind === "day"
        ? { month: "short", day: "numeric", timeZone }
        : kind === "month"
          ? { month: "short", timeZone }
          : { year: "numeric", timeZone },
  ).format(new Date(iso));
}

function formatChartCrosshairTime(
  iso: string,
  range: QuoteRange | undefined,
  timeZone: string,
): string {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "—";
  return new Intl.DateTimeFormat(
    "en-CA",
    range === "1D"
      ? { hour: "numeric", minute: "2-digit", timeZone }
      : range === "5D"
        ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone }
        : { month: "short", day: "numeric", year: "numeric", timeZone },
  ).format(value);
}

/** Bare axis number, no currency symbol, so labels stay narrow. */
function formatChartAxisValue(cents: number): string {
  return new Intl.NumberFormat("en-CA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function chartTimeTicks(
  points: ChartPoint[],
  xFractions: number[],
  timeZone: string,
  maxTicks: number,
) {
  const parts = points.map((point) => chartClockParts(point.at, timeZone));
  if (parts.some((part) => part === null)) return [];
  const clock = parts as ChartClockParts[];
  // Labels too close to an edge would be clipped, so they are skipped.
  const fits = (index: number) => xFractions[index] > 0.05 && xFractions[index] < 0.95;
  let chosen: { kind: ChartTickKind; indices: number[] } | null = null;

  for (const step of CHART_TICK_STEPS) {
    const indices: number[] = [];
    for (let index = 1; index < points.length; index += 1) {
      if (step.key(clock[index]) !== step.key(clock[index - 1]) && fits(index)) {
        indices.push(index);
      }
    }
    if (indices.length === 0) continue;
    if (indices.length <= maxTicks) {
      // A lone coarse label ("Oct") says less than a thinned finer set.
      if (indices.length === 1 && chosen) break;
      chosen = { kind: step.kind, indices };
      break;
    }
    chosen = { kind: step.kind, indices };
  }
  if (!chosen) return [];

  const { kind, indices } = chosen;
  const stride = Math.max(1, Math.ceil(indices.length / maxTicks));
  return indices
    .filter((_, position) => position % stride === 0)
    .map((index) => ({
      at: points[index].at,
      x: xFractions[index],
      label: formatChartTick(points[index].at, kind, timeZone),
    }));
}

function niceChartStep(rough: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(rough, 1)));
  const normalized = rough / magnitude;
  const multiplier =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  const step = multiplier * magnitude;
  // Cents are whole numbers; 2.5 cents rounds up to the next clean step.
  return Number.isInteger(step) ? step : 5 * magnitude;
}

function chartGeometry(
  points: ChartPoint[],
  width: number,
  height: number,
  {
    compressGaps = false,
    referenceCents = null,
    tickCount = 4,
    includeVolume = true,
    ohlc = false,
  }: {
    compressGaps?: boolean;
    referenceCents?: number | null;
    tickCount?: number;
    includeVolume?: boolean;
    /** Candles and bars: fit each bar's high and low, not just its close. */
    ohlc?: boolean;
  } = {},
) {
  const values = points.map((point) => point.valueCents);
  // Bars without a recorded open open at the previous close; high and low
  // then fall back to the wider of open and close.
  const bars = points.map((point, index) => {
    const openCents = point.openCents ?? points[index - 1]?.valueCents ?? point.valueCents;
    return {
      openCents,
      closeCents: point.valueCents,
      highCents: point.highCents ?? Math.max(openCents, point.valueCents),
      lowCents: point.lowCents ?? Math.min(openCents, point.valueCents),
    };
  });
  const dataMin = ohlc
    ? Math.min(...bars.map((bar) => bar.lowCents))
    : Math.min(...values);
  const dataMax = ohlc
    ? Math.max(...bars.map((bar) => bar.highCents))
    : Math.max(...values);
  const low = referenceCents === null ? dataMin : Math.min(dataMin, referenceCents);
  const high = referenceCents === null ? dataMax : Math.max(dataMax, referenceCents);
  const padding =
    high > low ? (high - low) * 0.08 : Math.max(Math.abs(high) * 0.01, 1);
  const min = low - padding;
  const max = high + padding;
  const spread = max - min;

  const volumes = points.map((point) => point.volume ?? 0);
  const maxVolume = Math.max(...volumes);
  const showVolume = includeVolume && maxVolume > 0;

  const top = 10;
  const plotBottom = height - 2;
  const volumeHeight = showVolume ? (plotBottom - top) * 0.16 : 0;
  const bottom = plotBottom - volumeHeight - (showVolume ? 8 : 0);
  const left = 2;
  const right = width - 4;
  const times = points.map((point) => Date.parse(point.at));
  const validTimes = times.every((time) => Number.isFinite(time));
  const firstTime = times[0];
  const timeSpread = validTimes ? Math.max(times.at(-1)! - firstTime, 1) : 1;
  const toY = (cents: number) => bottom - ((cents - min) / spread) * (bottom - top);

  const coordinates = points.map((point, index) => ({
    x:
      left +
      (validTimes && !compressGaps
        ? (times[index] - firstTime) / timeSpread
        : index / Math.max(points.length - 1, 1)) *
        (right - left),
    y: toY(point.valueCents),
  }));

  const step = niceChartStep(spread / tickCount);
  const yTicks: { value: number; y: number }[] = [];
  for (let value = Math.ceil(min / step) * step; value <= max; value += step) {
    yTicks.push({ value, y: toY(value) });
  }

  const barWidth = Math.max(((right - left) / points.length) * 0.6, 0.6);
  const priceBars = coordinates.map((coordinate, index) => {
    const bar = bars[index];
    return {
      at: points[index].at,
      x: coordinate.x,
      width: barWidth,
      up: bar.closeCents >= bar.openCents,
      openY: toY(bar.openCents),
      closeY: toY(bar.closeCents),
      highY: toY(bar.highCents),
      lowY: toY(bar.lowCents),
    };
  });
  const volumeBars = showVolume
    ? coordinates.map((coordinate, index) => {
        const barHeight = (volumes[index] / maxVolume) * volumeHeight;
        const point = points[index];
        const openCents = point.openCents ?? points[index - 1]?.valueCents ?? point.valueCents;
        return {
          at: point.at,
          up: point.valueCents >= openCents,
          x: coordinate.x - barWidth / 2,
          y: plotBottom - barHeight,
          width: barWidth,
          height: barHeight,
        };
      })
    : [];

  const path = coordinates
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");

  return {
    dataMin,
    dataMax,
    top,
    plotBottom,
    left,
    right,
    toY,
    coordinates,
    yTicks,
    volumeBars,
    priceBars,
    path,
    areaPath: `${path} L${coordinates.at(-1)!.x.toFixed(1)} ${plotBottom} L${coordinates[0].x.toFixed(1)} ${plotBottom} Z`,
  };
}

function ChartStyleIcon({ style }: { style: ChartStyle }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      {style === "line" ? (
        <path d="M1 12l4-5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.6" />
      ) : style === "candle" ? (
        <g stroke="currentColor" strokeWidth="1.4">
          <path d="M4.5 2v12M11.5 1v13" fill="none" />
          <rect x="2.5" y="5" width="4" height="5" fill="currentColor" />
          <rect x="9.5" y="3.5" width="4" height="7" fill="none" />
        </g>
      ) : (
        <g stroke="currentColor" strokeWidth="1.6" fill="none">
          <path d="M5 2v12M2.5 5H5M5 10h2.5" />
          <path d="M11 3v11M8.5 11H11M11 6h2.5" />
        </g>
      )}
    </svg>
  );
}

function ChartReadout({
  point,
  currency,
  announce,
  hasVolume,
  volumeOpen,
  onToggleVolume,
}: {
  point: ChartPoint;
  currency: "CAD" | "USD";
  /** Read keyboard and touch moves aloud; mouse sweeps stay quiet. */
  announce: boolean;
  hasVolume: boolean;
  volumeOpen: boolean;
  onToggleVolume: () => void;
}) {
  const fields: [string, string][] = [
    ["O", point.openCents],
    ["H", point.highCents],
    ["L", point.lowCents],
    ["C", point.valueCents],
  ]
    .filter((field): field is [string, number] => field[1] != null)
    .map(([key, cents]) => [key, formatChartAxisValue(cents)]);
  if (point.volume != null) {
    fields.push([
      "V",
      new Intl.NumberFormat("en-CA", { notation: "compact", maximumFractionDigits: 1 }).format(
        point.volume,
      ),
    ]);
  }
  return (
    <div className="chart__legend">
      <dl
        className="chart__readout"
        role="status"
        aria-live={announce ? "polite" : "off"}
        aria-atomic="true"
      >
        {fields.map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        <div className="chart__readout-currency">
          <dt>{currency}</dt>
        </div>
      </dl>
      {hasVolume ? (
        <div className="chart__study">
          <span>
            Vol undr
            {volumeOpen && point.volume != null ? (
              <strong>{formatChartVolume(point.volume)}</strong>
            ) : null}
          </span>
          <button
            type="button"
            className="chart__study-toggle"
            aria-pressed={volumeOpen}
            aria-label={volumeOpen ? "Hide volume underlay" : "Show volume underlay"}
            data-open={volumeOpen}
            onClick={onToggleVolume}
          >
            <ChevronDownIcon />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function LineChart({
  points,
  label,
  compact = false,
  currency = "CAD",
  range,
  timeZone = "America/Toronto",
  loading = false,
  emptyMessage = "History is unavailable.",
  interactive = false,
  compressGaps = false,
  referenceCents = null,
  expanded = false,
  chartStyle = "line",
}: {
  points: ChartPoint[];
  label: string;
  compact?: boolean;
  currency?: "CAD" | "USD";
  range?: QuoteRange;
  timeZone?: string;
  loading?: boolean;
  emptyMessage?: string;
  interactive?: boolean;
  compressGaps?: boolean;
  /** Dashed baseline, such as the previous close on a 1D chart. */
  referenceCents?: number | null;
  /** Full-screen detail view: denser axes, gridlines, and an OHLCV readout. */
  expanded?: boolean;
  chartStyle?: ChartStyle;
}) {
  const width = expanded ? 1200 : compact ? 440 : 640;
  const height = expanded ? 560 : compact ? 156 : 250;
  const svgRef = useRef<SVGSVGElement>(null);
  const gradientId = `chart-fill-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [activeAt, setActiveAt] = useState<string | null>(null);
  // Rendered chart width in CSS pixels, captured on interaction, so the
  // hover box can pick a side that has room for it.
  const [renderedWidth, setRenderedWidth] = useState(0);
  // The hover box may spill over the price axis, so that strip counts as room.
  const [axisWidth, setAxisWidth] = useState(0);
  const [volumeOpen, setVolumeOpen] = useState(true);
  // The plot's drawn width, so time labels never crowd on a narrow screen.
  const [plotWidth, setPlotWidth] = useState(0);
  const hasPlot = !loading && points.length >= 2;
  useEffect(() => {
    const svg = svgRef.current;
    if (!hasPlot || !svg) return;
    const observer = new ResizeObserver(([entry]) => setPlotWidth(entry.contentRect.width));
    observer.observe(svg);
    return () => observer.disconnect();
  }, [hasPlot]);
  const [interactionMethod, setInteractionMethod] = useState<
    "keyboard" | "mouse" | "touch" | null
  >(null);

  if (loading || points.length < 2) {
    return (
      <div
        className={`chart chart--empty ${compact ? "chart--compact" : ""} ${expanded ? "chart--expanded" : ""}`}
        aria-busy={loading}
        role="status"
      >
        <span>{loading ? "Loading real market history…" : emptyMessage}</span>
      </div>
    );
  }

  const geometry = chartGeometry(points, width, height, {
    compressGaps,
    referenceCents,
    tickCount: expanded ? 8 : compact ? 3 : 4,
    includeVolume: !expanded || volumeOpen,
    ohlc: chartStyle !== "line",
  });
  const lastPoint = points.at(-1)!;
  const lastCoordinate = geometry.coordinates.at(-1)!;
  const positive = lastPoint.valueCents >= (referenceCents ?? points[0].valueCents);
  const formatValue = (value: number) => formatNativeMoney(value, currency);
  const timeTicks = chartTimeTicks(
    points,
    geometry.coordinates.map((coordinate) => coordinate.x / width),
    timeZone,
    Math.min(
      expanded ? 12 : compact ? 3 : 6,
      // About one label per 90px (110px in the larger expanded type).
      plotWidth > 0 ? Math.max(2, Math.floor(plotWidth / (expanded ? 110 : 90))) : Infinity,
    ),
  );
  const requestedActivePointIndex = activeAt === null
    ? -1
    : points.findIndex((point) => point.at === activeAt);
  const activePointIndex = activeAt === null
    ? null
    : requestedActivePointIndex >= 0
      ? requestedActivePointIndex
      : points.length - 1;
  const activePoint = activePointIndex === null ? null : points[activePointIndex];
  const activeCoordinate = activePointIndex === null
    ? null
    : geometry.coordinates[activePointIndex];

  const toTopPercent = (y: number) => `${(y / height) * 100}%`;
  const toLeftPercent = (x: number) => `${(x / width) * 100}%`;

  // Price badges on the right axis; plain tick labels make way for them.
  const badges = [
    referenceCents === null
      ? null
      : { key: "reference", tone: "reference", value: referenceCents },
    { key: "last", tone: positive ? "up" : "down", value: lastPoint.valueCents },
    activePoint ? { key: "active", tone: "active", value: activePoint.valueCents } : null,
  ].filter((badge) => badge !== null);
  const badgeYs = badges.map((badge) => geometry.toY(badge.value));
  const tickClearance = height * 0.07;
  // An invisible copy of the widest label sizes the axis column to fit.
  const widestAxisLabel = [
    ...geometry.yTicks.map((tick) => tick.value),
    ...badges.map((badge) => badge.value),
  ]
    .map(formatChartAxisValue)
    .reduce((widest, text) => (text.length > widest.length ? text : widest), "");
  const visibleYTicks = geometry.yTicks.filter((tick) =>
    badgeYs.every((y) => Math.abs(y - tick.y) > tickClearance),
  );

  const selectPoint = (index: number, method: "keyboard" | "mouse" | "touch") => {
    const boundedIndex = Math.max(0, Math.min(points.length - 1, index));
    setActiveAt(points[boundedIndex].at);
    setInteractionMethod(method);
    const svgWidth = svgRef.current?.getBoundingClientRect().width ?? 0;
    const bodyWidth =
      svgRef.current?.closest(".chart__body")?.getBoundingClientRect().width ?? svgWidth;
    setRenderedWidth(svgWidth);
    setAxisWidth(Math.max(bodyWidth - svgWidth, 0));
  };

  // The box sits beside the hovered line, never on it: to the right on the
  // left half of the chart, to the left on the right half. A side without
  // room for the box loses to the other; with room on neither (very narrow
  // screens) it pins to the edge farther from the line.
  const tooltipPlacement = (() => {
    if (!activeCoordinate) return "after";
    const chartWidth = renderedWidth > 0 ? renderedWidth : width;
    const lineX = (activeCoordinate.x / width) * chartWidth;
    const fitsAfter = chartWidth + axisWidth - lineX >= CHART_TOOLTIP_SPACE_PX;
    const fitsBefore = lineX >= CHART_TOOLTIP_SPACE_PX;
    const preferAfter = lineX < chartWidth / 2;
    if (preferAfter ? fitsAfter : fitsBefore) return preferAfter ? "after" : "before";
    if (preferAfter ? fitsBefore : fitsAfter) return preferAfter ? "before" : "after";
    return preferAfter ? "pin-end" : "pin-start";
  })();

  const selectNearestPointerPoint = (event: ReactPointerEvent<SVGSVGElement>) => {
    const bounds = svgRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0) return;
    const plotX = ((event.clientX - bounds.left) / bounds.width) * width;
    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    geometry.coordinates.forEach((coordinate, index) => {
      const distance = Math.abs(coordinate.x - plotX);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    });
    selectPoint(nearestIndex, event.pointerType === "mouse" ? "mouse" : "touch");
  };

  const handleChartKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!interactive) return;
    const currentIndex = activePointIndex ?? points.length - 1;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      selectPoint(currentIndex - 1, "keyboard");
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      selectPoint(currentIndex + 1, "keyboard");
    } else if (event.key === "Home") {
      event.preventDefault();
      selectPoint(0, "keyboard");
    } else if (event.key === "End") {
      event.preventDefault();
      selectPoint(points.length - 1, "keyboard");
    } else if (event.key === "Escape" && activeAt !== null) {
      // Only swallow Escape when it clears a selection, so a second press
      // still reaches an enclosing dialog.
      event.preventDefault();
      setActiveAt(null);
      setInteractionMethod(null);
    }
  };

  return (
    <div
      className={`chart chart--style-${chartStyle} ${compact ? "chart--compact" : ""} ${expanded ? "chart--expanded" : ""} ${interactive ? "chart--interactive" : ""}`}
      data-chart-mode={interactive ? "market" : undefined}
      data-gap-scale={compressGaps ? "compressed" : "elapsed-time"}
      role={interactive ? "group" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-keyshortcuts={interactive ? "ArrowLeft ArrowRight Home End Escape" : undefined}
      aria-label={
        interactive
          ? `${label} in ${currency}. Hover, tap, or use Left and Right arrow keys to review real market bars. Home and End jump to the first and latest bars.`
          : undefined
      }
      onFocus={
        interactive
          ? () => {
              if (activeAt === null) selectPoint(points.length - 1, "keyboard");
            }
          : undefined
      }
      onBlur={interactive ? () => {
        setActiveAt(null);
        setInteractionMethod(null);
      } : undefined}
      onKeyDown={interactive ? handleChartKeyDown : undefined}
    >
      <div className="chart__body">
        <div className="chart__plot">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            aria-hidden={interactive ? "true" : undefined}
            focusable="false"
            role={interactive ? undefined : "img"}
            aria-label={
              interactive
                ? undefined
                : `${label}. Low ${formatValue(geometry.dataMin)}, high ${formatValue(
                    geometry.dataMax,
                  )}.`
            }
            onPointerMove={interactive ? selectNearestPointerPoint : undefined}
            onPointerDown={interactive ? selectNearestPointerPoint : undefined}
            onPointerLeave={
              interactive
                ? (event) => {
                    if (event.pointerType === "mouse") {
                      setActiveAt(null);
                      setInteractionMethod(null);
                    }
                  }
                : undefined
            }
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" className="chart__fill-stop chart__fill-stop--top" />
                <stop offset="100%" className="chart__fill-stop chart__fill-stop--bottom" />
              </linearGradient>
            </defs>
            {geometry.yTicks.map((tick) => (
              <line
                key={tick.value}
                x1={geometry.left}
                x2={width}
                y1={tick.y}
                y2={tick.y}
                className="chart__grid"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {expanded
              ? timeTicks.map((tick) => (
                  <line
                    key={tick.at}
                    x1={tick.x * width}
                    x2={tick.x * width}
                    y1={0}
                    y2={geometry.plotBottom}
                    className="chart__grid"
                    vectorEffect="non-scaling-stroke"
                  />
                ))
              : null}
            {chartStyle === "line" ? (
              <path d={geometry.areaPath} className="chart__area" fill={`url(#${gradientId})`} />
            ) : null}
            {geometry.volumeBars.map((bar) => (
              <rect
                key={bar.at}
                x={bar.x}
                y={bar.y}
                width={bar.width}
                height={bar.height}
                className={`chart__volume${
                  expanded ? ` chart__volume--${bar.up ? "up" : "down"}` : ""
                }`}
              />
            ))}
            {referenceCents !== null ? (
              <line
                x1={geometry.left}
                x2={width}
                y1={geometry.toY(referenceCents)}
                y2={geometry.toY(referenceCents)}
                className="chart__reference"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
            <line
              x1={geometry.left}
              x2={width}
              y1={lastCoordinate.y}
              y2={lastCoordinate.y}
              className={`chart__price-line chart__price-line--${positive ? "up" : "down"}`}
              vectorEffect="non-scaling-stroke"
            />
            {chartStyle === "line" ? (
              <path
                d={geometry.path}
                className="chart__line"
                vectorEffect="non-scaling-stroke"
              />
            ) : (
              <g className={`chart__price-bars chart__price-bars--${chartStyle}`}>
                {geometry.priceBars.map((bar) => {
                  const tone = bar.up ? "up" : "down";
                  if (chartStyle === "candle") {
                    const top = Math.min(bar.openY, bar.closeY);
                    return (
                      <g key={bar.at} className={`chart__candle chart__candle--${tone}`}>
                        <line
                          x1={bar.x}
                          x2={bar.x}
                          y1={bar.highY}
                          y2={bar.lowY}
                          vectorEffect="non-scaling-stroke"
                        />
                        <rect
                          x={bar.x - bar.width / 2}
                          y={top}
                          width={bar.width}
                          // A flat bar still shows as a thin line.
                          height={Math.max(Math.abs(bar.closeY - bar.openY), 0.6)}
                        />
                      </g>
                    );
                  }
                  return (
                    <g key={bar.at} className={`chart__ohlc chart__ohlc--${tone}`}>
                      <line
                        x1={bar.x}
                        x2={bar.x}
                        y1={bar.highY}
                        y2={bar.lowY}
                        vectorEffect="non-scaling-stroke"
                      />
                      <line
                        x1={bar.x - bar.width / 2}
                        x2={bar.x}
                        y1={bar.openY}
                        y2={bar.openY}
                        vectorEffect="non-scaling-stroke"
                      />
                      <line
                        x1={bar.x}
                        x2={bar.x + bar.width / 2}
                        y1={bar.closeY}
                        y2={bar.closeY}
                        vectorEffect="non-scaling-stroke"
                      />
                    </g>
                  );
                })}
              </g>
            )}
            <circle
              cx={lastCoordinate.x}
              cy={lastCoordinate.y}
              r="3.5"
              className="chart__last-point"
              vectorEffect="non-scaling-stroke"
            />
            {activeCoordinate ? (
              <>
                <line
                  x1={activeCoordinate.x}
                  x2={activeCoordinate.x}
                  y1={geometry.top}
                  y2={geometry.plotBottom}
                  className="chart__crosshair"
                  vectorEffect="non-scaling-stroke"
                />
                <line
                  x1={geometry.left}
                  x2={width}
                  y1={activeCoordinate.y}
                  y2={activeCoordinate.y}
                  className="chart__crosshair chart__crosshair--level"
                  vectorEffect="non-scaling-stroke"
                />
                <circle
                  cx={activeCoordinate.x}
                  cy={activeCoordinate.y}
                  r="5"
                  className="chart__active-point"
                  vectorEffect="non-scaling-stroke"
                />
              </>
            ) : null}
            {geometry.coordinates.map((coordinate, index) => (
              <circle
                key={points[index].at}
                cx={coordinate.x}
                cy={coordinate.y}
                r="6"
                className="chart__hit-point"
                data-chart-point
                data-at={points[index].at}
              />
            ))}
            {interactive ? (
              <rect
                x={geometry.left}
                y={geometry.top}
                width={geometry.right - geometry.left}
                height={geometry.plotBottom - geometry.top}
                className="chart__interaction-surface"
              />
            ) : null}
          </svg>
          {expanded ? (
            <ChartReadout
              point={activePoint ?? lastPoint}
              currency={currency}
              announce={activePoint !== null && interactionMethod !== "mouse"}
              hasVolume={points.some((point) => (point.volume ?? 0) > 0)}
              volumeOpen={volumeOpen}
              onToggleVolume={() => setVolumeOpen((open) => !open)}
            />
          ) : null}
          {activePoint && activeCoordinate && !expanded ? (
            <div
              className={`chart__tooltip chart__tooltip--${tooltipPlacement}`}
              style={
                tooltipPlacement.startsWith("pin")
                  ? undefined
                  : { left: toLeftPercent(activeCoordinate.x) }
              }
              data-placement={tooltipPlacement}
              data-chart-tooltip
              role="status"
              aria-live={interactionMethod === "mouse" ? "off" : "polite"}
              aria-atomic="true"
            >
              <time dateTime={activePoint.at}>
                {formatChartTooltipTime(activePoint.at, timeZone)}
              </time>
              <dl>
                <div>
                  <dt>Close</dt>
                  <dd>{formatValue(activePoint.valueCents)}</dd>
                </div>
                {activePoint.openCents != null ? (
                  <div>
                    <dt>Open</dt>
                    <dd>{formatValue(activePoint.openCents)}</dd>
                  </div>
                ) : null}
                {activePoint.highCents != null ? (
                  <div>
                    <dt>High</dt>
                    <dd>{formatValue(activePoint.highCents)}</dd>
                  </div>
                ) : null}
                {activePoint.lowCents != null ? (
                  <div>
                    <dt>Low</dt>
                    <dd>{formatValue(activePoint.lowCents)}</dd>
                  </div>
                ) : null}
                {activePoint.volume != null ? (
                  <div>
                    <dt>Volume</dt>
                    <dd>{formatChartVolume(activePoint.volume)}</dd>
                  </div>
                ) : null}
              </dl>
            </div>
          ) : null}
        </div>
        <div className="chart__y-axis" aria-hidden="true">
          <span className="chart__y-sizer">{widestAxisLabel}</span>
          {visibleYTicks.map((tick) => (
            <span key={tick.value} className="chart__y-tick" style={{ top: toTopPercent(tick.y) }}>
              {formatChartAxisValue(tick.value)}
            </span>
          ))}
          {badges.map((badge) => (
            <span
              key={badge.key}
              className={`chart__badge chart__badge--${badge.tone}`}
              style={{ top: toTopPercent(geometry.toY(badge.value)) }}
            >
              {formatChartAxisValue(badge.value)}
            </span>
          ))}
        </div>
        <div className="chart__x-axis" aria-hidden="true">
          {timeTicks.map((tick) => (
            <span
              key={tick.at}
              className="chart__x-tick"
              style={{ left: `${tick.x * 100}%` }}
            >
              {tick.label}
            </span>
          ))}
          {activePoint && activeCoordinate ? (
            <span
              className="chart__x-badge"
              style={{ left: toLeftPercent(activeCoordinate.x) }}
            >
              {formatChartCrosshairTime(activePoint.at, range, timeZone)}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function PanelHeading({
  id,
  title,
  icon,
  aside,
}: {
  id?: string;
  title: string;
  icon?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="panel-heading">
      <h2 id={id}>
        {icon}
        {title}
      </h2>
      {aside ? <div className="panel-heading__aside">{aside}</div> : null}
    </div>
  );
}

function CollapsiblePanelHeading({
  id,
  controlsId,
  title,
  icon,
  aside,
  isOpen,
  onToggle,
}: {
  id: string;
  controlsId: string;
  title: string;
  icon?: ReactNode;
  aside?: ReactNode;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const shouldReduceMotion = useReducedMotion();

  return (
    <button
      className="panel-heading panel-heading--collapsible"
      type="button"
      aria-expanded={isOpen}
      aria-controls={controlsId}
      onClick={onToggle}
    >
      <span className="panel-heading__title" id={id} role="heading" aria-level={2}>
        {icon}
        {title}
      </span>
      <span className="panel-heading__tools">
        {aside ? <span className="panel-heading__aside">{aside}</span> : null}
        <motion.span
          className="panel-heading__chevron-motion"
          aria-hidden="true"
          animate={{ rotate: isOpen ? 180 : 0 }}
          transition={
            shouldReduceMotion
              ? { duration: 0 }
              : { duration: 0.2, ease: [0.16, 1, 0.3, 1] }
          }
        >
          <ChevronDownIcon className="panel-heading__chevron" />
        </motion.span>
      </span>
    </button>
  );
}

function AnimatedRailSection({
  className,
  headingId,
  contentId,
  title,
  icon,
  aside,
  isOpen,
  onToggle,
  dataFlash,
  children,
}: {
  className: string;
  headingId: string;
  contentId: string;
  title: string;
  icon?: ReactNode;
  aside?: ReactNode;
  isOpen: boolean;
  onToggle: () => void;
  dataFlash?: boolean;
  children: ReactNode;
}) {
  const shouldReduceMotion = useReducedMotion();
  const reducedTransition = { duration: 0 } as const;

  return (
    <section
      className={`rail-section ${className}`}
      data-open={isOpen}
      data-flash={dataFlash}
      aria-labelledby={headingId}
    >
      <CollapsiblePanelHeading
        id={headingId}
        controlsId={contentId}
        title={title}
        icon={icon}
        aside={aside}
        isOpen={isOpen}
        onToggle={onToggle}
      />
      <AnimatePresence initial={false}>
        {isOpen ? (
          <motion.div
            key={contentId}
            id={contentId}
            className="rail-section__content"
            initial={{ height: 0, opacity: shouldReduceMotion ? 1 : 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{
              height: 0,
              opacity: shouldReduceMotion ? 1 : 0,
              transition: shouldReduceMotion
                ? reducedTransition
                : {
                    height: { duration: 0.22, ease: [0.4, 0, 1, 1] },
                    opacity: { duration: 0.12, ease: "easeIn" },
                  },
            }}
            transition={
              shouldReduceMotion
                ? reducedTransition
                : {
                    height: { duration: 0.3, ease: [0.16, 1, 0.3, 1] },
                    opacity: { duration: 0.18, ease: "easeOut" },
                  }
            }
          >
            <div className="rail-section__content-inner">{children}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}

// Which activity a viewer has already seen lives in this browser only; it
// just decides whether the bell shows a "new" bubble.
const ACTIVITY_SEEN_EVENT = "luban:activity-seen";
const activitySeenFallback = new Map<string, string>();

function readActivitySeen(key: string): string | null {
  try {
    return window.localStorage.getItem(key) ?? activitySeenFallback.get(key) ?? null;
  } catch {
    return activitySeenFallback.get(key) ?? null;
  }
}

function writeActivitySeen(key: string, value: string): void {
  activitySeenFallback.set(key, value);
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private windows can refuse storage; the in-memory copy still works.
  }
  window.dispatchEvent(new Event(ACTIVITY_SEEN_EVENT));
}

function subscribeActivitySeen(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(ACTIVITY_SEEN_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(ACTIVITY_SEEN_EVENT, onChange);
  };
}

/**
 * A labelled header button that opens a panel beneath it. Clicking outside
 * or pressing Escape closes it, and Escape hands focus back to the button.
 */
function HeaderMenu({
  label,
  icon,
  children,
}: {
  label: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="header-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="header-menu__button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
      >
        {icon}
        <span>{label}</span>
        <ChevronDownIcon className="header-menu__chevron" />
      </button>
      <div
        className="header-menu__panel"
        id={panelId}
        role="region"
        aria-label={label}
        hidden={!open}
      >
        {children}
      </div>
    </div>
  );
}

function ActivityBell({
  items,
  title,
  emptyMessage,
  showTeamNames,
  storageKey,
  prompt,
}: {
  items: ActivityItem[];
  title: string;
  emptyMessage: string;
  showTeamNames: boolean;
  storageKey: string;
  /** A to-do for the signed-in person, pinned above the log until done. */
  prompt?: { title: string; detail: string; actionLabel: string; onAction: () => void };
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const seenAt = useSyncExternalStore(
    subscribeActivitySeen,
    () => readActivitySeen(storageKey),
    () => null,
  );
  const seenMs = seenAt === null ? Number.NEGATIVE_INFINITY : Date.parse(seenAt);
  const latest = items.reduce<ActivityItem | null>(
    (newest, item) =>
      newest === null || Date.parse(item.createdAt) > Date.parse(newest.createdAt)
        ? item
        : newest,
    null,
  );
  const unseen =
    items.filter((item) => Date.parse(item.createdAt) > seenMs).length + (prompt ? 1 : 0);

  // Anything that arrives while the feed is open counts as seen.
  useEffect(() => {
    if (open && latest && Date.parse(latest.createdAt) > seenMs) {
      writeActivitySeen(storageKey, latest.createdAt);
    }
  }, [latest, open, seenMs, storageKey]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="activity-bell" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="activity-bell__button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={unseen > 0 ? `${title}, ${unseen} new` : title}
        onClick={() => setOpen((current) => !current)}
      >
        <BellIcon />
        {unseen > 0 ? (
          <span className="activity-bell__badge" aria-hidden="true">
            {unseen > 9 ? "9+" : unseen}
          </span>
        ) : null}
      </button>
      <div
        className="activity-bell__panel"
        id={panelId}
        role="region"
        aria-labelledby={`${panelId}-title`}
        hidden={!open}
      >
        <div className="activity-bell__head">
          <h2 id={`${panelId}-title`}>{title}</h2>
          <span>Immutable log</span>
        </div>
        {prompt ? (
          <div className="activity-prompt">
            <div>
              <strong>{prompt.title}</strong>
              <p>{prompt.detail}</p>
            </div>
            <button
              type="button"
              className="button button--primary button--compact"
              onClick={() => {
                setOpen(false);
                prompt.onAction();
              }}
            >
              {prompt.actionLabel}
            </button>
          </div>
        ) : null}
        <ol className="activity-list">
          {items.length === 0 ? (
            <li className="activity-list__empty">
              <p>{emptyMessage}</p>
            </li>
          ) : (
            items.map((item) => (
              <li
                key={item.id}
                data-new={Date.parse(item.createdAt) > seenMs ? "true" : undefined}
              >
                <time dateTime={item.createdAt}>{formatActivityTime(item.createdAt)}</time>
                <div>
                  <strong>{item.title}</strong>
                  {showTeamNames && item.teamName ? (
                    <small className="activity-team-name">{item.teamName}</small>
                  ) : null}
                  <p>{item.detail}</p>
                </div>
                <span className={`activity-state activity-state--${item.type.toLowerCase()}`}>
                  {activityStateLabel(item.type)}
                </span>
              </li>
            ))
          )}
        </ol>
      </div>
    </div>
  );
}

/** Up, down, or flat, for tinting a figure's background. */
function trendOf(cents: number): "up" | "down" | "flat" {
  return cents > 0 ? "up" : cents < 0 ? "down" : "flat";
}

function ChangeValue({ cents, percent }: { cents?: number; percent: number }) {
  // Compare what is shown, so a +0.004% that displays as 0.00% reads as flat.
  const shown = cents ?? Math.round(percent * 100);
  if (shown === 0) {
    return (
      <span className="change change--flat">
        {cents === undefined ? "0.00%" : formatMoney(0)}
      </span>
    );
  }
  const className = shown > 0 ? "change change--positive" : "change change--negative";
  return (
    <span className={className}>
      {cents === undefined ? formatPercent(percent) : formatSignedMoney(cents)}
    </span>
  );
}


/* ──────────────────────────── Leaderboard ──────────────────────────── */

/** Teams listed before the leaderboard stops; your own team is added below. */
const LEADERBOARD_SIZE = 5;

/** The smallest return, either way, that fills half a leaderboard bar, so a
 * leader up 2% doesn't look like it has maxed out. */
const LEADERBOARD_MIN_SCALE_PERCENT = 10;

const TEAM_STATUS_LABELS: Record<LeaderboardRow["teamStatus"], string> = {
  active: "Active",
  frozen: "Frozen",
  disqualified: "Disqualified",
};

/**
 * The ranked teams, each with a bar for its return since the start. Every
 * bar shares one scale centred on 0%, so the gaps between teams read at a
 * glance. If your team ranks below the top five, its row follows them, set
 * apart. Hosts can open any team's map; a student only their own team's.
 */
function LeaderboardTable({
  rows,
  canOpenAnyMap,
  onOpenMap,
}: {
  rows: LeaderboardRow[];
  canOpenAnyMap: boolean;
  onOpenMap: (row: LeaderboardRow) => void;
}) {
  const top = rows.slice(0, LEADERBOARD_SIZE);
  const ownBelow = rows.slice(LEADERBOARD_SIZE).find((row) => row.isCurrentTeam) ?? null;
  const shown = ownBelow ? [...top, ownBelow] : top;
  const scale = Math.max(
    LEADERBOARD_MIN_SCALE_PERCENT,
    ...shown.map((row) => Math.abs(row.returnPercent)),
  );
  const canOpenMap = (row: LeaderboardRow) => canOpenAnyMap || row.isCurrentTeam;
  const hasMapColumn = shown.some(canOpenMap);
  const columnCount = hasMapColumn ? 5 : 4;

  const renderRow = (row: LeaderboardRow, pinned: boolean) => {
    const share = scale > 0 ? (Math.abs(row.returnPercent) / scale) * 50 : 0;
    const classes = [
      row.isCurrentTeam ? "is-current" : "",
      pinned ? "is-pinned" : "",
    ].filter(Boolean);

    return (
      <tr key={row.teamId} className={classes.join(" ") || undefined}>
        <td className="leaderboard-bars__rank">
          <span>{row.rank}</span>
        </td>
        <th scope="row" className="leaderboard-bars__team">
          <span className="leaderboard-bars__name">
            {row.teamName}
            {row.isCurrentTeam ? <span className="leaderboard-bars__you">You</span> : null}
          </span>
          {/* A narrow panel shows the value here instead of the trade count. */}
          <small>
            <span className="leaderboard-bars__inline-value">
              {formatMoney(row.totalValueCents)}
            </span>
            <span className="leaderboard-bars__trades">
              {row.tradeCount} {row.tradeCount === 1 ? "trade" : "trades"}
            </span>
            {row.teamStatus !== "active" ? (
              <span className="leaderboard-bars__status">
                {" · "}
                {TEAM_STATUS_LABELS[row.teamStatus]}
              </span>
            ) : null}
          </small>
        </th>
        <td className="leaderboard-bars__return">
          <span className="leaderboard-bars__track" aria-hidden="true">
            {share > 0 ? (
              <span
                className={`leaderboard-bars__bar leaderboard-bars__bar--${row.returnPercent >= 0 ? "up" : "down"}`}
                style={{ width: `max(${share}%, 3px)` }}
              />
            ) : null}
          </span>
          <ChangeValue percent={row.returnPercent} />
        </td>
        <td className="leaderboard-bars__value">
          {formatMoney(row.totalValueCents)}
          <small>
            <ChangeValue cents={row.returnCents} percent={row.returnPercent} />
          </small>
        </td>
        {hasMapColumn ? (
          <td className="leaderboard-bars__map">
            {canOpenMap(row) ? (
              <button
                type="button"
                className="leaderboard-map-button"
                aria-haspopup="dialog"
                aria-label={`Open ${row.teamName} portfolio map`}
                title="Portfolio map"
                onClick={() => onOpenMap(row)}
              >
                <TreemapIcon />
              </button>
            ) : null}
          </td>
        ) : null}
      </tr>
    );
  };

  return (
    <table className="leaderboard-bars">
      <thead>
        <tr>
          <th scope="col">#</th>
          <th scope="col">Team</th>
          <th scope="col">Return since start</th>
          <th scope="col">Value</th>
          {hasMapColumn ? (
            <th scope="col">
              <span className="sr-only">Map</span>
            </th>
          ) : null}
        </tr>
      </thead>
      <tbody>{top.map((row) => renderRow(row, false))}</tbody>
      {ownBelow ? (
        <tbody className="leaderboard-bars__pinned">
          <tr className="leaderboard-bars__gap">
            <td colSpan={columnCount}>Your team, outside the top {LEADERBOARD_SIZE}</td>
          </tr>
          {renderRow(ownBelow, true)}
        </tbody>
      ) : null}
    </table>
  );
}

/* ───────────────────────────── Watchlist ───────────────────────────── */

const SPARKLINE_TTL_MS = 5 * 60_000;
const IDLE_SPARKLINE_TTL_MS = 30 * 60_000;

function Sparkline({ closes }: { closes: number[] | null | undefined }) {
  if (!closes || closes.length < 2) {
    return <span className="sparkline sparkline--empty" aria-hidden="true" />;
  }

  const width = 64;
  const height = 22;
  const low = Math.min(...closes);
  const high = Math.max(...closes);
  const span = high - low || 1;
  const path = closes
    .map((close, index) => {
      const x = (index / (closes.length - 1)) * width;
      const y = height - 2 - ((close - low) / span) * (height - 4);
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const rising = closes[closes.length - 1] >= closes[0];

  return (
    <svg
      className={`sparkline ${rising ? "sparkline--up" : "sparkline--down"}`}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      aria-hidden="true"
      focusable="false"
    >
      <path d={path} fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

type WatchlistSortKey = "added" | "symbol" | "price" | "change";

function WatchlistTable({
  items,
  selectedSymbol,
  busySymbol,
  idle,
  onOpen,
  onRemove,
}: {
  items: WatchlistItemView[];
  selectedSymbol: string;
  busySymbol: string | null;
  idle: boolean;
  onOpen: (item: WatchlistItemView) => void;
  onRemove: (symbol: string) => void;
}) {
  const [sort, setSort] = useState<{ key: WatchlistSortKey; descending: boolean }>({
    key: "added",
    descending: false,
  });
  // Every row's sparkline comes from one request, redone every few minutes
  // and whenever the watchlist changes. A hidden tab sits out; coming back
  // reloads them if they expired meanwhile.
  const [sparklines, setSparklines] = useState<Record<string, number[] | null>>({});
  const symbolKey = items.map((item) => item.symbol).sort().join(",");
  // With every market shut the lines can't move, so they refresh less often.
  // A ref, so the switch itself doesn't restart the load.
  const ttlRef = useRef(SPARKLINE_TTL_MS);
  useEffect(() => {
    ttlRef.current = idle ? IDLE_SPARKLINE_TTL_MS : SPARKLINE_TTL_MS;
  }, [idle]);
  useEffect(() => {
    if (!symbolKey) return;
    let loadedAt = 0;
    const controller = new AbortController();
    const load = () => {
      if (document.hidden || Date.now() - loadedAt < ttlRef.current) return;
      loadedAt = Date.now();
      fetch("/api/quotes/sparklines", {
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      })
        .then((response) => (response.ok ? response.json() : null))
        .then((payload: { sparklines?: Record<string, number[] | null> } | null) => {
          if (payload?.sparklines) setSparklines(payload.sparklines);
          else loadedAt = 0; // retry on the next tick
        })
        .catch(() => {
          if (!controller.signal.aborted) loadedAt = 0;
        });
    };
    load();
    // Checks each minute but only fetches once the last load has expired.
    const timer = window.setInterval(load, 60_000);
    document.addEventListener("visibilitychange", load);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [symbolKey]);

  const sorted = useMemo(() => {
    const rows = items.map((item, index) => ({ item, index }));
    const value = ({ item, index }: { item: WatchlistItemView; index: number }) =>
      sort.key === "symbol"
        ? item.symbol
        : sort.key === "price"
          ? (item.quote?.priceCadCents ?? -Infinity)
          : sort.key === "change"
            ? (item.quote?.changePercent ?? -Infinity)
            : index;
    rows.sort((left, right) => {
      const a = value(left);
      const b = value(right);
      const order =
        typeof a === "string" && typeof b === "string"
          ? a.localeCompare(b)
          : Number(a) - Number(b);
      return sort.descending ? -order : order;
    });
    return rows.map((row) => row.item);
  }, [items, sort]);

  const sortHeader = (key: WatchlistSortKey, label: string) => {
    const active = sort.key === key;
    return (
      <th
        scope="col"
        aria-sort={active ? (sort.descending ? "descending" : "ascending") : "none"}
      >
        <button
          type="button"
          className="sort-button"
          onClick={() =>
            setSort((current) =>
              current.key === key
                ? { key, descending: !current.descending }
                : // Numbers read best largest first; names A to Z.
                  { key, descending: key !== "symbol" },
            )
          }
        >
          {label}
          <span aria-hidden="true" className="sort-button__arrow">
            {active ? (sort.descending ? "↓" : "↑") : ""}
          </span>
        </button>
      </th>
    );
  };

  return (
    <div className="table-scroll">
      <table className="data-table watchlist-table">
        <thead>
          <tr>
            {sortHeader("symbol", "Symbol")}
            {sortHeader("price", "Price")}
            {sortHeader("change", "Day")}
            <th scope="col">
              <span className="sr-only">Today&apos;s trend</span>
            </th>
            <th scope="col">
              <span className="sr-only">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((item) => {
            const tag = assetTagLabel(item.assetClass);
            return (
              <tr
                key={item.symbol}
                className={item.symbol === selectedSymbol ? "is-current" : undefined}
              >
                <th scope="row" data-label="Symbol">
                  <button
                    type="button"
                    className="symbol-button"
                    onClick={() => onOpen(item)}
                    title={item.addedByName ? `Added by ${item.addedByName}` : undefined}
                  >
                    <strong>
                      {item.symbol}
                      {tag ? <em className="asset-tag">{tag}</em> : null}
                    </strong>
                    <span>{item.name}</span>
                  </button>
                </th>
                <td data-label="Price">
                  {item.quote ? formatMoney(item.quote.priceCadCents) : "—"}
                </td>
                <td data-label="Day">
                  {item.quote ? <ChangeValue percent={item.quote.changePercent} /> : "—"}
                </td>
                <td data-label="Today" className="watchlist-table__spark">
                  <Sparkline closes={sparklines[item.symbol]} />
                </td>
                <td data-label="" className="watchlist-table__remove">
                  <button
                    type="button"
                    className="icon-button"
                    disabled={busySymbol !== null}
                    onClick={() => onRemove(item.symbol)}
                    aria-label={`Remove ${item.symbol} from the watchlist`}
                    title="Remove from watchlist"
                  >
                    <CloseIcon />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The tabs that share the portfolio column below the summary. */
type PortfolioView = "holdings" | "chart" | "orders" | "trades";

/* ──────────────────────────── Trade history ─────────────────────────── */

function formatTradeTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat("en-CA", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: DISPLAY_TIME_ZONE,
  }).format(parsed);
}

/** Most fills the history table loads at once; the CSV has every one. */
const TRADE_HISTORY_PAGE = 100;
/** Fills shown before "Show all". */
const TRADE_HISTORY_PREVIEW = 8;

function TradeHistoryTable({
  orders,
  showTeam,
  onSelectSymbol,
}: {
  orders: OrderView[];
  showTeam: boolean;
  onSelectSymbol: (symbol: string) => void;
}) {
  return (
    <div className="table-scroll">
      <table className="data-table trade-history-table">
        <thead>
          <tr>
            <th scope="col">Trade</th>
            <th scope="col">Quantity</th>
            <th scope="col">Price</th>
            <th scope="col">Total</th>
            <th scope="col">Realized</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => (
            <tr key={order.id}>
              <th scope="row" data-label="Trade">
                <strong>
                  <span className={`side-tag side-tag--${order.side.toLowerCase()}`}>
                    {order.side === "BUY" ? "Buy" : "Sell"}
                  </span>{" "}
                  <button
                    type="button"
                    className="symbol-link"
                    onClick={() => onSelectSymbol(order.symbol)}
                  >
                    {order.symbol}
                  </button>
                </strong>
                <small className="cell-note">
                  {formatTradeTime(order.createdAt)} ·{" "}
                  {showTeam ? `${order.teamName} · ${order.actorName}` : order.actorName}
                </small>
              </th>
              <td data-label="Quantity">{number.format(order.quantity)}</td>
              <td data-label="Price">{formatMoney(order.fillPriceCadCents)}</td>
              <td data-label="Total">{formatMoney(order.grossCents)}</td>
              <td data-label="Realized">
                {typeof order.realizedGainCents === "number" ? (
                  <ChangeValue cents={order.realizedGainCents} percent={0} />
                ) : (
                  <span className="cell-muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Starts a browser download of text the page already has. */
function downloadTextFile(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function holdingsCsv(holdings: HoldingView[]): string {
  return toCsv(
    [
      "Symbol",
      "Name",
      "Exchange",
      "Listing currency",
      "Quantity",
      "Average cost (CAD)",
      "Price (CAD)",
      "Cost basis (CAD)",
      "Market value (CAD)",
      "Unrealized gain (CAD)",
      "Unrealized gain (%)",
      "Portfolio weight (%)",
    ],
    holdings.map((holding) => [
      holding.symbol,
      holding.name,
      holding.exchange,
      holding.listingCurrency,
      holding.quantity,
      centsToDecimal(holding.averageCostCents),
      centsToDecimal(holding.currentPriceCadCents),
      centsToDecimal(holding.costBasisCents),
      centsToDecimal(holding.marketValueCents),
      centsToDecimal(holding.gainLossCents),
      holding.gainLossPercent,
      holding.portfolioWeightPercent,
    ]),
  );
}

export interface SimulatorAppProps {
  /** demo (default): seeded identities and the identity switcher. */
  authMode?: AuthMode;
  /** Rendered in the header instead of the demo identity switcher. */
  accountControls?: ReactNode;
  /** The signed-in person's dashboard, built with the page; skips the first load. */
  initialDashboard?: DashboardPayload;
}

export function SimulatorApp({
  authMode = "demo",
  accountControls,
  initialDashboard,
}: SimulatorAppProps = {}) {
  const isManaged = authMode === "managed";
  const router = useRouter();
  const [dashboard, setDashboard] = useState<DashboardPayload>(
    initialDashboard ?? fallbackDashboard,
  );
  const [connection, setConnection] = useState<ConnectionState>(
    initialDashboard ? "connected" : "connecting",
  );
  // A dashboard built with the page proves the session already.
  const [sessionReady, setSessionReady] = useState(Boolean(initialDashboard));
  const [connectionError, setConnectionError] = useState("");
  const [selectedSymbol, setSelectedSymbol] = useState("SHOP.TO");
  const [selectedQuote, setSelectedQuote] = useState<Quote>(
    () =>
      initialDashboard?.availableSymbols.find((quote) => quote.symbol === "SHOP.TO") ??
      fallbackQuotes[0],
  );
  // The symbol on screen right now, and a counter that every new pick bumps,
  // so a slow lookup for an earlier pick can't land on top of a later one.
  const selectedSymbolRef = useRef(selectedSymbol);
  const selectionRequest = useRef(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<InstrumentSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  // Live suggestions under the search box, like a browser's address bar.
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const suggestionCache = useRef(new Map<string, InstrumentSearchResult[]>());
  // Every listing the page has seen (popular picks, prices, holdings, past
  // results), so suggestions can appear before the network answers.
  const knownInstruments = useRef(new Map<string, InstrumentSearchResult>());
  const [popularSections, setPopularSections] = useState<PopularSection[] | null>(
    null,
  );
  const [action, setAction] = useState<TradeAction>("BUY");
  // Orders are stored by side: a short sale sells and a cover buys.
  const side: TradeSide = action === "BUY" || action === "COVER" ? "BUY" : "SELL";
  const [quantity, setQuantity] = useState("10");
  const [orderType, setOrderType] = useState<TicketOrderType>("MARKET");
  const [triggerPrice, setTriggerPrice] = useState("");
  const [timeInForce, setTimeInForce] = useState<TimeInForce>("GTC");
  // Bracket exits start blank: they are optional.
  const [takeProfitPrice, setTakeProfitPrice] = useState("");
  const [stopLossPrice, setStopLossPrice] = useState("");
  // Exits stay folded until someone asks for them or has typed one.
  const [exitsOpen, setExitsOpen] = useState(false);
  const [cancellingOrderId, setCancellingOrderId] = useState<string | null>(null);
  const [workingOrdersFeedback, setWorkingOrdersFeedback] = useState<TicketStatus | null>(
    null,
  );
  const [ticketStatus, setTicketStatus] = useState<TicketStatus>({
    kind: "idle",
    message: "Ready for a simulated order.",
  });
  const [portfolioRange, setPortfolioRange] = useState("7D");
  const [portfolioView, setPortfolioView] = useState<PortfolioView>("holdings");
  const [quoteRange, setQuoteRange] = useState<QuoteRange>("1D");
  // Null means the range's own default bar size.
  const [quoteInterval, setQuoteInterval] = useState<QuoteInterval | null>(null);
  // A custom from/to window replaces the preset range while it is set.
  const [customWindow, setCustomWindow] = useState<{ from: string; to: string } | null>(
    null,
  );
  const [datePicker, setDatePicker] = useState<{
    from: string;
    to: string;
    error: string;
  } | null>(null);
  const [chartStyle, setChartStyle] = useState<ChartStyle>("line");
  const chartDialogRef = useRef<HTMLDialogElement>(null);
  const maxConfirmRef = useRef<HTMLDialogElement>(null);
  const buyBlockedRef = useRef<HTMLDialogElement>(null);
  // The portfolio map renders only while its dialog is open (view not null).
  const mapDialogRef = useRef<HTMLDialogElement>(null);
  // A pre-loaded account still named "User 1" is asked for a name on arrival,
  // unless they chose Later on this browser; the bell keeps the reminder.
  const [namePrompt, setNamePrompt] = useState<"auto" | "open" | "closed">("auto");
  const namePromptLater = useNamePromptLater(dashboard.currentUser.id);
  const namePromptOpen =
    namePrompt === "open" ||
    (namePrompt === "auto" && Boolean(dashboard.currentUser.needsDisplayName) && !namePromptLater);
  const [mapView, setMapView] = useState<MapDialogView | null>(null);
  const mapRequest = useRef<AbortController | null>(null);
  const [chartExpanded, setChartExpanded] = useState(false);
  const [quoteHistory, setQuoteHistory] = useState<QuoteHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [identityBusy, setIdentityBusy] = useState(false);
  const [hostBusy, setHostBusy] = useState(false);
  const [scheduleStartDraft, setScheduleStartDraft] = useState<string | null>(null);
  const [scheduleEndDraft, setScheduleEndDraft] = useState<string | null>(null);
  const [scheduleCashDraft, setScheduleCashDraft] = useState<string | null>(null);
  const [adminOverview, setAdminOverview] = useState<AdminOverview | null>(null);
  const [adminCashDraft, setAdminCashDraft] = useState<string | null>(null);
  const [adminCashBusy, setAdminCashBusy] = useState(false);
  const [adminCashFeedback, setAdminCashFeedback] = useState<TicketStatus | null>(
    null,
  );
  const [hostFeedback, setHostFeedback] = useState("");
  const [resetArmed, setResetArmed] = useState(false);
  const [watchBusy, setWatchBusy] = useState<string | null>(null);
  const [watchFeedback, setWatchFeedback] = useState<TicketStatus | null>(null);
  // The full trade history loads only when someone asks for it.
  const [tradeHistoryOpen, setTradeHistoryOpen] = useState(false);
  const [tradeHistory, setTradeHistory] = useState<OrderView[] | null>(null);
  const [tradeHistoryError, setTradeHistoryError] = useState("");
  const [sandboxResetArmed, setSandboxResetArmed] = useState(false);
  const [sandboxResetBusy, setSandboxResetBusy] = useState(false);
  const [syncFlash, setSyncFlash] = useState(false);
  const [openRailSections, setOpenRailSections] = useState(INITIAL_RAIL_SECTIONS);
  const dashboardRequest = useRef<AbortController | null>(null);
  // Survives an ambiguous network failure so a manual retry of the same
  // ticket replays idempotently instead of double-filling.
  const pendingOrder = useRef<{ key: string; fingerprint: string } | null>(null);
  const autoLoginAttempted = useRef(false);
  const knownVersion = useRef(initialDashboard?.team?.version ?? fallbackTeam.version);
  // The portfolio history this page already holds, so each poll only asks
  // for newer points. The last point is always the live value.
  const historyCache = useRef<{ teamId: string; points: PortfolioPoint[] } | null>(
    initialDashboard?.team
      ? { teamId: initialDashboard.team.id, points: initialDashboard.portfolioHistory }
      : null,
  );
  const lastMarketRefreshAttemptAt = useRef(0);

  const toggleRailSection = useCallback((section: RailSectionId) => {
    setOpenRailSections((current) => ({
      ...current,
      [section]: !current[section],
    }));
  }, []);

  useEffect(() => {
    if (sessionReady) return;
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch("/api/auth/session", {
          cache: "no-store",
          credentials: "same-origin",
        });
        const payload = (await readJson(response)) as {
          authenticated?: boolean;
        } & ApiErrorShape;
        if (!response.ok) {
          throw new Error(extractError(payload, "The demo session could not be checked."));
        }

        if (!payload.authenticated) {
          if (isManaged) {
            router.push("/sign-in");
            return;
          }

          const login = await startDemoSession();
          const loginPayload = await readJson(login);
          if (!login.ok) {
            throw new Error(extractError(loginPayload, "The demo session could not start."));
          }
        }
        setSessionReady(true);
      } catch (error) {
        setConnectionError(
          error instanceof Error ? error.message : "The demo session could not start.",
        );
        setSessionReady(true);
      }
    }, 0);

    return () => window.clearTimeout(timer);
  }, [isManaged, router, sessionReady]);

  const fetchDashboard = useCallback(async (
    announce = false,
    refreshMarket = false,
  ) => {
    if (dashboardRequest.current && !announce) return;
    dashboardRequest.current?.abort();
    const controller = new AbortController();
    dashboardRequest.current = controller;
    if (refreshMarket) lastMarketRefreshAttemptAt.current = Date.now();
    const dashboardParams = new URLSearchParams({
      refreshMarket: refreshMarket ? "1" : "0",
      // Read through the ref so a symbol switch doesn't restart the poll.
      symbol: selectedSymbolRef.current,
    });
    const heldHistory = historyCache.current;
    if (heldHistory && heldHistory.points.length >= 2) {
      dashboardParams.set("historyTeam", heldHistory.teamId);
      dashboardParams.set("historyAfter", heldHistory.points[heldHistory.points.length - 2].at);
    }
    const dashboardUrl = `/api/dashboard?${dashboardParams.toString()}`;

    try {
      let response = await fetch(dashboardUrl, {
        signal: controller.signal,
        cache: "no-store",
        credentials: "same-origin",
      });

      if (response.status === 401 && !autoLoginAttempted.current) {
        autoLoginAttempted.current = true;

        if (isManaged) {
          router.push("/sign-in");
          return;
        }

        const login = await startDemoSession();
        if (login.ok) {
          response = await fetch(dashboardUrl, {
            signal: controller.signal,
            cache: "no-store",
            credentials: "same-origin",
          });
        }
      }

      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(extractError(payload, "The local simulator server did not respond."));
      }

      let nextDashboard = payload as DashboardPayload;
      // A partial history adds to the copy this page holds, replacing its
      // live last point.
      if (
        nextDashboard.portfolioHistoryAfter &&
        heldHistory &&
        heldHistory.teamId === nextDashboard.team?.id
      ) {
        const after = nextDashboard.portfolioHistoryAfter;
        nextDashboard = {
          ...nextDashboard,
          portfolioHistory: [
            ...heldHistory.points.slice(0, -1).filter((point) => point.at <= after),
            ...nextDashboard.portfolioHistory,
          ].slice(-PORTFOLIO_HISTORY_KEEP),
        };
      }
      if (controller.signal.aborted) return;
      const nextVersion = nextDashboard.team?.version ?? 0;
      const changed = nextVersion > knownVersion.current;
      knownVersion.current = nextVersion;
      historyCache.current = nextDashboard.team
        ? { teamId: nextDashboard.team.id, points: nextDashboard.portfolioHistory }
        : null;
      setDashboard(nextDashboard);
      // The update carries a fresh price for the symbol on screen.
      setSelectedQuote((current) => {
        const liveQuote = nextDashboard.availableSymbols.find(
          (quote) => quote.symbol === current.symbol,
        );
        return liveQuote ?? current;
      });
      // A fresh price retires the "waiting for a fresh quote" notice.
      const liveSelected = nextDashboard.availableSymbols.find(
        (quote) => quote.symbol === selectedSymbolRef.current,
      );
      if (liveSelected && !liveSelected.isStale) {
        setTicketStatus((current) =>
          current.message === STALE_SNAPSHOT_MESSAGE
            ? { kind: "idle", message: "Ready for a simulated order." }
            : current,
        );
      }
      setConnection("connected");
      setConnectionError("");

      if (changed || announce) {
        setSyncFlash(true);
        window.setTimeout(() => setSyncFlash(false), 900);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setConnection((current) =>
        current === "connecting" ? "connecting" : "reconnecting",
      );
      setConnectionError(
        error instanceof Error ? error.message : "Could not reach the local server.",
      );
    } finally {
      if (dashboardRequest.current === controller) dashboardRequest.current = null;
    }
  }, [isManaged, router]);

  // The full history loads when its panel is on screen. New trades reach it
  // from dashboard.recentOrders (see tradeRows) instead of a refetch.
  const historyUserId = dashboard.currentUser.id;
  const tradeHistoryVisible = tradeHistoryOpen && portfolioView === "trades";
  useEffect(() => {
    if (!tradeHistoryVisible) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/orders?limit=${TRADE_HISTORY_PAGE}`, {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        const payload = (await readJson(response)) as {
          orders?: OrderView[];
        } & ApiErrorShape;
        if (!response.ok || !payload.orders) {
          throw new Error(extractError(payload, "The trade history could not load."));
        }
        setTradeHistory(payload.orders);
        setTradeHistoryError("");
      } catch (error) {
        if (controller.signal.aborted) return;
        setTradeHistoryError(
          error instanceof Error ? error.message : "The trade history could not load.",
        );
      }
    })();
    return () => controller.abort();
  }, [tradeHistoryVisible, historyUserId]);

  // Nothing can move while every market on the page is shut, so the poll slows.
  const marketsIdle = allMarketsClosed(dashboard.availableSymbols);
  const marketsIdleRef = useRef(marketsIdle);
  useEffect(() => {
    marketsIdleRef.current = marketsIdle;
  }, [marketsIdle]);

  useEffect(() => {
    if (!sessionReady) return;
    let lastPollAt = 0;
    // Hidden tabs sit out. The 1 s of slack lets a tick that lands just short
    // of a full interval still count.
    const pollIfDue = (every: number) => {
      if (document.hidden || Date.now() - lastPollAt < every - 1_000) return;
      lastPollAt = Date.now();
      const refreshMarket =
        lastPollAt - lastMarketRefreshAttemptAt.current >= MARKET_REFRESH_INTERVAL_MS;
      void fetchDashboard(false, refreshMarket);
    };
    const onTick = () =>
      pollIfDue(marketsIdleRef.current ? IDLE_SYNC_INTERVAL_MS : TEAM_SYNC_INTERVAL_MS);
    // Back on the tab: catch up now if a minute has passed.
    const onVisible = () => pollIfDue(TEAM_SYNC_INTERVAL_MS);
    const initial = window.setTimeout(() => pollIfDue(0), 0);
    const interval = window.setInterval(onTick, TEAM_SYNC_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      dashboardRequest.current?.abort();
      dashboardRequest.current = null;
    };
  }, [fetchDashboard, sessionReady]);

  useEffect(() => {
    if (!sessionReady || connection !== "connected") return;
    const controller = new AbortController();

    async function loadQuoteHistory() {
      await Promise.resolve();
      if (controller.signal.aborted) return;
      setHistoryLoading(true);
      setHistoryError("");
      setQuoteHistory(null);
      try {
        const params = new URLSearchParams({ symbol: selectedSymbol });
        if (customWindow) {
          params.set("from", customWindow.from);
          params.set("to", customWindow.to);
        } else {
          params.set("range", quoteRange);
        }
        if (quoteInterval) params.set("interval", quoteInterval);
        const response = await fetch(
          `/api/quotes/history?${params.toString()}`,
          {
            cache: "no-store",
            credentials: "same-origin",
            signal: controller.signal,
          },
        );
        const payload = (await readJson(response)) as QuoteHistoryPayload;
        if (!response.ok || !payload.quote || !payload.history) {
          throw new Error(extractError(payload, "Market history is unavailable."));
        }
        setSelectedQuote(payload.quote);
        setQuoteHistory(payload.history);
        if (payload.quote.isStale || payload.history.isStale) {
          setTicketStatus({
            kind: "error",
            message: STALE_SNAPSHOT_MESSAGE,
          });
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          const message =
            error instanceof Error ? error.message : "Market history is unavailable.";
          setHistoryError(message);
          setTicketStatus({ kind: "error", message });
        }
      } finally {
        if (!controller.signal.aborted) setHistoryLoading(false);
      }
    }

    void loadQuoteHistory();
    return () => controller.abort();
  }, [
    connection,
    customWindow,
    historyRefreshKey,
    quoteInterval,
    quoteRange,
    selectedSymbol,
    sessionReady,
  ]);

  const fetchAdminOverview = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/overview", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(extractError(payload, "The team controls could not be loaded."));
      }
      setAdminOverview(payload as AdminOverview);
    } catch (error) {
      setHostFeedback(
        error instanceof Error ? error.message : "The team controls could not be loaded.",
      );
    }
  }, []);

  useEffect(() => {
    if (
      dashboard.currentUser.role !== "host" &&
      dashboard.currentUser.role !== "platform_admin"
    ) {
      return;
    }
    const timer = window.setTimeout(() => void fetchAdminOverview(), 0);
    return () => window.clearTimeout(timer);
  }, [dashboard.currentUser.role, fetchAdminOverview]);

  const portfolio = dashboard.portfolio ?? emptyPortfolio;
  const teamVersion = dashboard.team?.version ?? 0;
  const rows = dashboard.leaderboard;
  const quotePoints = useMemo(
    () =>
      quoteHistory?.points.map((point) => ({
        ...point,
        at: point.at,
        valueCents: point.closeCents,
      })) ?? [],
    [quoteHistory],
  );
  const historyWindow = useMemo(() => {
    if (customWindow) {
      const custom = customHistoryWindow(customWindow.from, customWindow.to);
      if (custom.ok) return custom.window;
    }
    return presetHistoryWindow(quoteRange);
  }, [customWindow, quoteRange]);
  const availableIntervals = useMemo(() => allowedIntervals(historyWindow), [historyWindow]);
  const activeInterval =
    resolveInterval(
      historyWindow,
      quoteInterval ?? (customWindow ? null : DEFAULT_QUOTE_INTERVAL[quoteRange]),
    ) ?? DEFAULT_QUOTE_INTERVAL[quoteRange];
  // Time formats follow the bar size: clock times for one day of intraday
  // bars, date and time across days, dates for daily and weekly bars.
  const chartFormatRange: QuoteRange = isIntradayInterval(activeInterval)
    ? historyWindow.spanDays <= 1
      ? "1D"
      : "5D"
    : "3M";
  const selectQuoteRange = (range: QuoteRange) => {
    setCustomWindow(null);
    setDatePicker(null);
    setQuoteRange(range);
    // Keep a chosen bar size when the new range can still serve it.
    if (quoteInterval && !allowedIntervals(presetHistoryWindow(range)).includes(quoteInterval)) {
      setQuoteInterval(null);
    }
  };
  const applyDatePicker = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!datePicker) return;
    const custom = customHistoryWindow(datePicker.from, datePicker.to);
    if (!custom.ok) {
      setDatePicker({ ...datePicker, error: custom.message });
      return;
    }
    if (quoteInterval && !allowedIntervals(custom.window).includes(quoteInterval)) {
      setQuoteInterval(null);
    }
    setCustomWindow({ from: datePicker.from, to: datePicker.to });
    setDatePicker(null);
  };
  const openDatePicker = () => {
    const today = torontoToday();
    const firstPoint = quotePoints[0]?.at;
    setDatePicker({
      from:
        customWindow?.from ??
        (firstPoint ? torontoToday(new Date(firstPoint)) : today),
      to: customWindow?.to ?? today,
      error: "",
    });
  };

  // 7D and 1M show only that window, starting from the last value before it
  // so the line spans the whole range. ALL shows everything.
  const portfolioRangePoints = useMemo(() => {
    const history = dashboard.portfolioHistory;
    const days = portfolioRange === "7D" ? 7 : portfolioRange === "1M" ? 30 : null;
    if (days === null || history.length === 0) return history;
    const endMs = Date.parse(dashboard.serverTime);
    const cutoff = endMs - days * 86_400_000;
    const firstInside = history.findIndex((point) => Date.parse(point.at) >= cutoff);
    if (firstInside === -1) return history.slice(-1);
    return history.slice(Math.max(0, firstInside - 1));
  }, [dashboard.portfolioHistory, dashboard.serverTime, portfolioRange]);
  const wholeQuantity = Number(quantity);
  const quantityIsValid =
    Number.isInteger(wholeQuantity) && wholeQuantity > 0 && wholeQuantity <= MAX_ORDER_QUANTITY;
  const holdingForQuote = dashboard.holdings.find(
    (holding) => holding.symbol === selectedQuote.symbol,
  );
  // Crypto trades in lots of `lotSize` tokens; every crypto price and quantity
  // in the API is already per lot, so the UI only relabels units.
  const selectedAssetClass = selectedQuote.assetClass ?? "STOCK";
  const selectedIsCrypto = selectedAssetClass === "CRYPTO";
  const selectedLotSize = selectedQuote.lotSize ?? 1;
  const selectedToken = cryptoTokenSymbol(selectedQuote.symbol);
  const selectedAssetTag = assetTagLabel(selectedQuote.assetClass);
  const tradingHaltReason = selectedQuote.tradingHaltReason ?? null;
  const heldQuantity = holdingForQuote?.quantity ?? 0;
  // Shares (lots) held back for the team's waiting sells can't be sold again.
  const reservedQuantity = Math.min(
    Math.max(0, heldQuantity),
    holdingForQuote?.reservedQuantity ?? 0,
  );
  const freeQuantity = Math.max(0, heldQuantity) - reservedQuantity;
  // Below zero the team is short. Buy and short open (or grow) a position;
  // sell and cover close one. No action crosses zero.
  const shortQuantity = Math.max(0, -heldQuantity);
  const positionAfter = heldQuantity + (side === "BUY" ? wholeQuantity : -wholeQuantity);
  const workingOrdersEnabled = dashboard.workingOrdersEnabled;
  // Stop loss and take profit only sell; switching to Buy falls back to Market.
  // Short sales and covers are market orders only.
  const ticketOrderType: TicketOrderType =
    !workingOrdersEnabled || action === "SHORT" || action === "COVER"
    ? "MARKET"
    : side === "BUY" && (orderType === "STOP_LOSS" || orderType === "TAKE_PROFIT")
      ? "MARKET"
      : orderType;
  const isWaitingOrder = ticketOrderType !== "MARKET";
  const ticketPrice = (value: string, round: "down" | "up") =>
    parseTicketPrice(value, selectedIsCrypto, selectedLotSize, round);
  // Buys and stops round down, sells at a target round up (see parseTicketPrice).
  const triggerParsed: TicketPrice = isWaitingOrder
    ? ticketPrice(
        triggerPrice,
        ticketOrderType === "TAKE_PROFIT" || (ticketOrderType === "LIMIT" && side === "SELL")
          ? "up"
          : "down",
      )
    : { cents: null, rounded: false };
  const triggerPriceCents = triggerParsed.cents || null;
  const bracketAllowed =
    workingOrdersEnabled &&
    action === "BUY" &&
    (ticketOrderType === "MARKET" || ticketOrderType === "LIMIT");
  const takeProfitEntered = bracketAllowed && takeProfitPrice.trim() !== "";
  const stopLossEntered = bracketAllowed && stopLossPrice.trim() !== "";
  const takeProfitParsed: TicketPrice = takeProfitEntered
    ? ticketPrice(takeProfitPrice, "up")
    : { cents: null, rounded: false };
  const stopLossParsed: TicketPrice = stopLossEntered
    ? ticketPrice(stopLossPrice, "down")
    : { cents: null, rounded: false };
  const takeProfitCents = takeProfitParsed.cents || null;
  const stopLossCents = stopLossParsed.cents || null;
  // The smallest crypto price step: one cent per lot, shown per token.
  const priceStepText = selectedIsCrypto
    ? `${formatPerTokenMoney(1, selectedLotSize, selectedQuote.listingCurrency)} per ${selectedToken}`
    : "";
  const bracketLegs = (takeProfitCents ? 1 : 0) + (stopLossCents ? 1 : 0);
  const openWorkingOrderCount = dashboard.workingOrders.filter(
    (order) => order.status === "WORKING" || order.status === "PENDING_PARENT",
  ).length;
  const showWorkingOrders = workingOrdersEnabled || dashboard.workingOrders.length > 0;
  const portfolioViews: Array<{ id: PortfolioView; label: string; count?: number }> = [
    { id: "holdings", label: "Holdings", count: dashboard.holdings.length },
    { id: "chart", label: "Value history" },
    ...(showWorkingOrders
      ? [{ id: "orders" as const, label: "Waiting orders", count: openWorkingOrderCount }]
      : []),
    { id: "trades", label: "Trade history" },
  ];
  const activePortfolioView =
    portfolioView === "orders" && !showWorkingOrders ? "holdings" : portfolioView;
  const newWorkingOrderCount = (isWaitingOrder ? 1 : 0) + bracketLegs;
  // A limit buy sets aside its cost at the limit, in CAD, exactly the way the
  // server does (same helper): rounded up per share, with a 2% currency
  // cushion for USD listings.
  const setsAsideCash = side === "BUY" && ticketOrderType === "LIMIT";
  const ticketUnitCadCents =
    isWaitingOrder && triggerPriceCents !== null
      ? reservedCadCentsPerUnit(
          triggerPriceCents,
          selectedQuote.fxRateBasisPoints,
          setsAsideCash ? selectedQuote.listingCurrency : "CAD",
        )
      : selectedQuote.priceCadCents;
  const estimatedValue = quantityIsValid ? ticketUnitCadCents * wholeQuantity : 0;
  const exitsShown = exitsOpen || takeProfitPrice.trim() !== "" || stopLossPrice.trim() !== "";
  // The price an exit is judged against: the limit for a limit buy, or the
  // current price for a market buy.
  const bracketEntryCents =
    ticketOrderType === "LIMIT" ? triggerPriceCents : selectedQuote.priceCents;
  const priceInputUnit = selectedIsCrypto
    ? `${selectedQuote.listingCurrency} per ${selectedToken}`
    : selectedQuote.listingCurrency;
  const currentPriceText = formatTicketPrice(
    selectedQuote.priceCents,
    selectedQuote.listingCurrency,
    selectedIsCrypto,
    selectedLotSize,
  );
  const ticketPriceText = (cents: number) =>
    formatTicketPrice(cents, selectedQuote.listingCurrency, selectedIsCrypto, selectedLotSize);
  const triggerPriceLabel =
    ticketOrderType === "STOP_LOSS"
      ? "Stop price"
      : ticketOrderType === "TAKE_PROFIT"
        ? "Target price"
        : "Limit price";
  // Why the waiting-order parts of the ticket can't be sent yet, or null.
  const waitingOrderProblem: string | null =
    isWaitingOrder && triggerPriceCents === null
      ? triggerPrice.trim() === ""
        ? `Enter a ${triggerPriceLabel.toLowerCase()}.`
        : triggerParsed.cents === 0
          ? `That ${triggerPriceLabel.toLowerCase()} is below the smallest step of ${priceStepText}.`
          : `Enter the ${triggerPriceLabel.toLowerCase()} as a positive amount${selectedIsCrypto ? "" : " with up to two decimals"}.`
      : ticketOrderType === "STOP_LOSS" &&
          triggerPriceCents !== null &&
          triggerPriceCents >= selectedQuote.priceCents
        ? `A stop loss sells if the price falls, so set it below the current price of ${currentPriceText}.`
        : ticketOrderType === "TAKE_PROFIT" &&
            triggerPriceCents !== null &&
            triggerPriceCents <= selectedQuote.priceCents
          ? `A take profit sells if the price rises, so set it above the current price of ${currentPriceText}.`
          : takeProfitEntered && takeProfitCents === null
            ? takeProfitParsed.cents === 0
              ? `The take profit is below the smallest step of ${priceStepText}.`
              : "Enter a valid take profit price, or leave it blank."
            : stopLossEntered && stopLossCents === null
              ? stopLossParsed.cents === 0
                ? `The stop loss is below the smallest step of ${priceStepText}.`
                : "Enter a valid stop loss price, or leave it blank."
              : takeProfitCents !== null &&
                  bracketEntryCents !== null &&
                  takeProfitCents <= bracketEntryCents
                ? `The take profit must be above the ${ticketOrderType === "LIMIT" ? "limit price" : "current price"} of ${ticketPriceText(bracketEntryCents)}.`
                : stopLossCents !== null &&
                    bracketEntryCents !== null &&
                    stopLossCents >= bracketEntryCents
                  ? `The stop loss must be below the ${ticketOrderType === "LIMIT" ? "limit price" : "current price"} of ${ticketPriceText(bracketEntryCents)}.`
                  : openWorkingOrderCount + newWorkingOrderCount > MAX_OPEN_WORKING_ORDERS_PER_TEAM
                    ? `A ${isPlatformAdminRole(dashboard) ? "test account" : "team"} can have at most ${MAX_OPEN_WORKING_ORDERS_PER_TEAM} waiting orders. Cancel one first.`
                    : null;
  const holdingsHaveLots = dashboard.holdings.some(
    (holding) => holding.assetClass === "CRYPTO",
  );
  const isPlatformAdmin = dashboard.currentUser.role === "platform_admin";
  const isCompetitionHost = dashboard.currentUser.role === "host";
  const canManageCompetition = isCompetitionHost || isPlatformAdmin;
  // A watchlist belongs to a portfolio: a team's, or an admin's test account.
  const canKeepWatchlist = !isCompetitionHost && dashboard.team !== null;
  const isWatched = dashboard.watchlist.some((item) => item.symbol === selectedQuote.symbol);
  const watchlistFull = dashboard.watchlist.length >= MAX_WATCHLIST_ITEMS;
  const tradeRows = tradeHistoryOpen
    ? tradeHistory
      ? [
          // Trades newer than the loaded page, from the latest dashboard.
          ...dashboard.recentOrders.filter(
            (order) => !tradeHistory.some((held) => held.id === order.id),
          ),
          ...tradeHistory,
        ]
      : dashboard.recentOrders
    : dashboard.recentOrders.slice(0, TRADE_HISTORY_PREVIEW);
  const hasAdminTradingAccount =
    isPlatformAdmin && dashboard.team !== null && dashboard.portfolio !== null;
  const tradingAccountIsOpen =
    hasAdminTradingAccount ||
    (dashboard.currentUser.role === "student" &&
      dashboard.team?.status === "active" &&
      dashboard.competition.tradingOpen);
  const quoteLoaded =
    connection === "connected" &&
    !(selectedQuote.source === "LUBAN_SIMULATED" && selectedQuote.isStale);
  // What a buy leaves to spend; null until there's a total to subtract.
  const receiptCashLeft =
    action === "BUY" && quoteLoaded && quantityIsValid && (!isWaitingOrder || triggerPriceCents !== null)
      ? portfolio.buyingPowerCents - estimatedValue
      : null;
  // Students can only trade while the listing's exchange is open; the server
  // enforces this too. The admin sandbox ignores market hours.
  const marketOpenForTrader = isPlatformAdmin || selectedQuote.marketOpen;
  const accountName = isPlatformAdmin ? "admin test account" : "team";
  // Why the order button is disabled, in plain words, or null when it isn't.
  // Shown live under the ticket so a greyed-out button always explains itself.
  // A host can end the competition before its scheduled end; the scheduled
  // date would then read as a future "ended" date.
  const competitionEndedEarly =
    dashboard.competition.status === "ended" &&
    dashboard.competition.endsAt > dashboard.serverTime;
  // A listing that can't be bought or shorted (e.g. a penny stock) leaves the
  // button live so a click explains why in a popup; a banner says so up front.
  const buyBlockedReason =
    selectedQuote.buyBlockedReason && (action === "BUY" || action === "SHORT")
      ? selectedQuote.buyBlockedReason
      : null;
  const tradeBlockedReason: string | null =
    connection !== "connected"
      ? "Wait for the simulator to reconnect before trading."
      : selectedQuote.isStale
        ? "Trading waits for a fresh market quote."
        : tradingHaltReason
          ? tradingHaltReason
            : isPlatformAdmin && !hasAdminTradingAccount
            ? "Set your admin test cash before placing an order."
            : isCompetitionHost
              ? "Host accounts are view-only and cannot place orders."
              : !tradingAccountIsOpen
                ? dashboard.team?.status === "frozen"
                  ? "Your team is frozen. Ask the host to restore trading."
                  : dashboard.team?.status === "disqualified"
                    ? "Your team is disqualified and cannot trade."
                    : dashboard.competition.phase === "scheduled"
                      ? `Trading opens ${formatScheduleInstant(dashboard.competition.startsAt)}.`
                      : dashboard.competition.phase === "ended"
                        ? competitionEndedEarly
                          ? "The host has ended this competition."
                          : `This competition ended ${formatScheduleInstant(dashboard.competition.endsAt)}.`
                        : dashboard.competition.phase === "paused"
                          ? "Trading is paused by the host."
                          : "Trading is not open for your account yet."
                : !marketOpenForTrader && !isWaitingOrder
                  ? selectedQuote.marketOpensAt
                    ? `The ${selectedQuote.exchange} market is closed. It reopens ${formatScheduleInstant(selectedQuote.marketOpensAt)}.`
                    : `The ${selectedQuote.exchange} market is closed. Stocks and ETFs trade 9:30 a.m. to 4:00 p.m. ET on weekdays; crypto trades 24/7.`
                  : !quantityIsValid
                    ? `Enter a positive whole number of ${unitWord(selectedAssetClass, 2)}.`
                    : waitingOrderProblem
                      ? waitingOrderProblem
                      : action === "BUY" && heldQuantity < 0
                        ? `The ${accountName} is short ${number.format(shortQuantity)} ${unitWord(selectedAssetClass, shortQuantity)} of ${selectedQuote.symbol}. Choose Buy to cover to buy them back.`
                      : action === "SHORT" && heldQuantity > 0
                        ? `The ${accountName} owns ${number.format(heldQuantity)} ${unitWord(selectedAssetClass, heldQuantity)} of ${selectedQuote.symbol}. Sell them before shorting it.`
                      : action === "COVER" && wholeQuantity > shortQuantity
                        ? shortQuantity === 0
                          ? `The ${accountName} isn't short ${selectedQuote.symbol}.`
                          : `The ${accountName} is short only ${number.format(shortQuantity)} ${unitWord(selectedAssetClass, shortQuantity)} of ${selectedQuote.symbol}.`
                      : receiptCashLeft !== null && receiptCashLeft < 0
                        ? `This order is larger than the ${accountName}'s available cash${
                            portfolio.reservedCashCents > 0
                              ? ` (${formatMoney(portfolio.reservedCashCents)} is set aside for waiting buys)`
                              : ""
                          }${
                            portfolio.shortLiabilityCents > 0
                              ? `. Cash from short sales is owed back, so it can't fund buys`
                              : ""
                          }.`
                        : action === "SELL" && wholeQuantity > freeQuantity
                          ? heldQuantity <= 0
                            ? `The ${accountName} doesn't hold any ${selectedQuote.symbol}. To bet on a fall, choose Short.`
                            : reservedQuantity > 0
                              ? `Only ${number.format(freeQuantity)} of the ${accountName}'s ${number.format(heldQuantity)} ${unitWord(selectedAssetClass, heldQuantity)} of ${selectedQuote.symbol} are free; the rest are held back for waiting sells.`
                              : `The ${accountName} holds only ${number.format(heldQuantity)} ${unitWord(selectedAssetClass, heldQuantity)} of ${selectedQuote.symbol}${
                                  selectedIsCrypto
                                    ? ` (${tokenAmountLabel(heldQuantity, selectedLotSize, selectedQuote.symbol)})`
                                    : ""
                                }.`
                          : null;
  const canTrade = tradeBlockedReason === null;
  // Exits waiting on a limit buy are listed right under it.
  const workingOrderRows = useMemo(() => {
    const open = dashboard.workingOrders;
    const ids = new Set(open.map((order) => order.id));
    const rows: Array<{ order: WorkingOrderView; attached: boolean }> = [];
    for (const order of open) {
      if (order.parentId && ids.has(order.parentId)) continue;
      rows.push({ order, attached: false });
      for (const exit of open) {
        if (exit.parentId === order.id) rows.push({ order: exit, attached: true });
      }
    }
    return rows;
  }, [dashboard.workingOrders]);
  // The most a single order can be: everything affordable (and within the
  // one-holding cap, which the admin sandbox skips) when buying, everything
  // held when selling. Whole units only.
  const buyLimitCents = isPlatformAdmin
    ? portfolio.buyingPowerCents
    : Math.min(
        portfolio.buyingPowerCents,
        positionRoomCents(
          portfolio.totalValueCents,
          Math.max(0, heldQuantity) * selectedQuote.priceCadCents,
        ),
      );
  // A short has the same one-holding cap as a buy (the admin sandbox skips it).
  const shortLimitCents = isPlatformAdmin
    ? Number.POSITIVE_INFINITY
    : positionRoomCents(
        portfolio.totalValueCents,
        shortQuantity * selectedQuote.priceCadCents,
      );
  const maxOrderQuantity =
    action === "COVER"
      ? Math.min(MAX_ORDER_QUANTITY, shortQuantity)
      : action === "SHORT"
        ? heldQuantity > 0 || ticketUnitCadCents <= 0
          ? 0
          : Math.min(MAX_ORDER_QUANTITY, Math.floor(shortLimitCents / ticketUnitCadCents))
    : action === "BUY"
      ? heldQuantity < 0
        ? 0
        : ticketUnitCadCents > 0
        ? Math.min(
            MAX_ORDER_QUANTITY,
            Math.max(0, Math.floor(buyLimitCents / ticketUnitCadCents)),
          )
        : 0
      : freeQuantity;
  // An idle note ("SHOP.TO loaded…") gives way to the reason trading is blocked.
  const displayedTicketStatus: TicketStatus =
    ticketStatus.kind === "idle" && tradeBlockedReason && quoteLoaded
      ? { kind: "blocked", message: tradeBlockedReason }
      : ticketStatus;
  const adminCashInputValue =
    adminCashDraft ?? (portfolio.cashCents / 100).toFixed(2);
  const parsedAdminCash = parseCashDraft(adminCashInputValue);
  const adminCashDraftError =
    adminCashDraft !== null && parsedAdminCash === null
      ? "Enter a non-negative CAD amount with no more than two decimal places."
      : null;
  const adminCashIsUnchanged =
    hasAdminTradingAccount && parsedAdminCash === portfolio.cashCents;
  const competitionHasTrades = (adminOverview?.teams ?? []).some(
    (team) => team.tradeCount > 0,
  );

  const switchIdentity = async (userId: string) => {
    setIdentityBusy(true);
    setAdminCashDraft(null);
    setAdminCashFeedback(null);
    setTicketStatus({ kind: "working", message: "Switching demo identity…" });
    try {
      const response = await fetch("/api/auth/demo-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(extractError(payload, "The demo identity could not be changed."));
      }
      await fetchDashboard(true);
      setTicketStatus({
        kind: "success",
        message: `Signed in as ${
          dashboard.session.demoUsers.find((user) => user.id === userId)?.name ??
          "the selected user"
        }.`,
      });
    } catch (error) {
      setTicketStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not switch identity.",
      });
    } finally {
      setIdentityBusy(false);
    }
  };

  // Only touches refs, so it is stable across renders.
  const rememberSuggestions = useCallback(
    (query: string, results: InstrumentSearchResult[]) => {
      const known = knownInstruments.current;
      for (const result of results) known.set(result.symbol, result);
      const cache = suggestionCache.current;
      cache.set(query.trim().toLowerCase(), results);
      if (cache.size > 100) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
    },
    [],
  );

  const changeSearchQuery = (value: string) => {
    setSearchQuery(value);
    setActiveSuggestion(-1);
    const query = value.trim();
    if (!query) {
      // An emptied box goes back to the popular picks.
      setSearchResults([]);
      setSuggesting(false);
      setSuggestionsOpen(true);
      return;
    }
    // Typing back to an earlier query reuses its results instantly.
    const cached = suggestionCache.current.get(query.toLowerCase());
    if (cached) {
      setSearchResults(cached);
      setSuggesting(false);
      setSuggestionsOpen(true);
      return;
    }
    // Otherwise show what the page already knows right away; the full search
    // replaces it a moment later.
    setSearchResults(rankLocalSuggestions(query, knownInstruments.current.values()));
    setSuggesting(true);
    setSuggestionsOpen(true);
  };

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const visible = visibleSuggestions.length;
    if (event.key === "ArrowDown" && visible > 0) {
      event.preventDefault();
      setSuggestionsOpen(true);
      setActiveSuggestion((index) => (index + 1) % visible);
    } else if (event.key === "ArrowUp" && visible > 0) {
      event.preventDefault();
      setSuggestionsOpen(true);
      setActiveSuggestion((index) => (index <= 0 ? visible - 1 : index - 1));
    } else if (event.key === "Escape" && suggestionsOpen) {
      event.preventDefault();
      setSuggestionsOpen(false);
      setActiveSuggestion(-1);
    } else if (
      event.key === "Enter" &&
      suggestionsOpen &&
      activeSuggestion >= 0 &&
      visibleSuggestions[activeSuggestion]
    ) {
      // A highlighted suggestion wins; otherwise Enter runs a normal search.
      event.preventDefault();
      void loadSearchResult(visibleSuggestions[activeSuggestion]);
    }
  };

  // "/" jumps to the symbol search from anywhere on the page, unless the
  // person is already typing in a field.
  useEffect(() => {
    const focusSearch = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      const search = document.getElementById("symbol-search");
      if (!search) return;
      event.preventDefault();
      search.focus();
      search.scrollIntoView({ block: "center", behavior: "smooth" });
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  // Load the popular picks in the background shortly after the page opens,
  // or as soon as someone focuses the search box, so they are ready there
  // without competing with the first dashboard and chart.
  const [popularWanted, setPopularWanted] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setPopularWanted(true), 3_000);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!popularWanted) return;
    const controller = new AbortController();
    void (async () => {
      try {
        // Kept for ten minutes per tab so reloads don't ask again.
        let sections: PopularSection[] | undefined;
        try {
          const saved = JSON.parse(sessionStorage.getItem(POPULAR_CACHE_KEY) ?? "null");
          if (saved && Date.now() - saved.at < POPULAR_CACHE_TTL_MS) sections = saved.sections;
        } catch {
          // Storage blocked or unreadable: fetch as usual.
        }
        if (!sections) {
          const response = await fetch("/api/quotes?popular=1", {
            signal: controller.signal,
          });
          if (!response.ok) return;
          const payload = (await readJson(response)) as { sections?: PopularSection[] };
          sections = payload.sections ?? [];
          try {
            sessionStorage.setItem(
              POPULAR_CACHE_KEY,
              JSON.stringify({ at: Date.now(), sections }),
            );
          } catch {
            // Over quota or blocked: the cache is optional.
          }
        }
        for (const section of sections) {
          for (const result of section.results) {
            knownInstruments.current.set(result.symbol, result);
          }
        }
        setPopularSections(sections);
      } catch {
        // Without popular picks the box simply opens empty.
      }
    })();
    return () => controller.abort();
  }, [popularWanted]);

  // Listings already on the page feed the instant suggestions too.
  useEffect(() => {
    const known = knownInstruments.current;
    for (const quote of dashboard.availableSymbols) {
      known.set(quote.symbol, {
        symbol: quote.symbol,
        name: quote.name,
        exchange: quote.exchange,
        sector: quote.sector,
        listingCurrency: quote.listingCurrency,
        assetClass: quote.assetClass,
      });
    }
  }, [dashboard.availableSymbols]);

  // Debounced live search. Each keystroke cancels the previous request, and
  // the server caches every query, so typing costs few upstream calls.
  useEffect(() => {
    const query = searchQuery.trim();
    // One character matches too much to be worth a request; Enter still searches.
    if (query.length < 2 || suggestionCache.current.has(query.toLowerCase())) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        // The browser may reuse a recent identical search (the server marks
        // results cacheable for five minutes).
        const response = await fetch(`/api/quotes?q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        });
        if (!response.ok) return;
        const payload = (await readJson(response)) as {
          results?: InstrumentSearchResult[];
        };
        const results = payload.results ?? [];
        rememberSuggestions(query, results);
        setSearchResults(results);
        setActiveSuggestion(-1);
        setSuggestionsOpen(true);
      } catch {
        // Aborted by the next keystroke, or offline: the submit path still works.
      } finally {
        if (!controller.signal.aborted) setSuggesting(false);
      }
    }, SUGGESTION_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [searchQuery, rememberSuggestions]);

  // With an empty box the list is the popular picks, grouped; once typing
  // starts it is the ranked results. Keyboard navigation walks either one.
  const showingPopular =
    !searchQuery.trim() && (popularSections?.some((s) => s.results.length > 0) ?? false);
  const popularGroups = (() => {
    let index = 0;
    return (popularSections ?? [])
      .filter((section) => section.results.length > 0)
      .map((section, sectionIndex) => ({
        title: section.title,
        headingId: `symbol-suggestions-group-${sectionIndex}`,
        results: section.results.map((result) => ({ result, index: index++ })),
      }));
  })();
  const visibleSuggestions = showingPopular
    ? popularGroups.flatMap((group) => group.results.map(({ result }) => result))
    : searchResults.slice(0, MAX_SUGGESTIONS);

  const renderSuggestion = (result: InstrumentSearchResult, index: number) => {
    const tag = assetTagLabel(result.assetClass);
    return (
      <li
        key={result.symbol}
        id={`symbol-suggestion-${index}`}
        role="option"
        aria-selected={index === activeSuggestion}
        className={index === activeSuggestion ? "is-active" : undefined}
        // Keep focus in the box so blur doesn't close the list before the
        // click lands.
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={() => setActiveSuggestion(index)}
        onClick={() => void loadSearchResult(result)}
      >
        <strong>{result.symbol}</strong>
        <span>{result.name}</span>
        <span>
          {tag ? <em className="asset-tag">{tag}</em> : null}
          {result.assetClass === "CRYPTO" ? null : <span>{result.exchange}</span>}
        </span>
      </li>
    );
  };

  const searchQuotes = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = searchQuery.trim();
    if (!query) return;
    setSearching(true);
    setSearchResults([]);
    try {
      // The suggestion search may already have fetched this query.
      let results = suggestionCache.current.get(query.toLowerCase());
      if (!results) {
        const response = await fetch(`/api/quotes?q=${encodeURIComponent(query)}`, {
          cache: "no-store",
        });
        const payload = (await readJson(response)) as {
          results?: InstrumentSearchResult[];
        } & ApiErrorShape;
        if (!response.ok) {
          throw new Error(extractError(payload, "The symbol search failed."));
        }
        results = payload.results ?? [];
        rememberSuggestions(query, results);
      }
      setSearchResults(results);
      setActiveSuggestion(-1);
      setSuggestionsOpen(true);
      const normalizedQuery = query
        .toUpperCase()
        .replace(/^([A-Z0-9]+)\.([A-Z])\.TO$/, "$1-$2.TO")
        .replace(/^([A-Z0-9]+)\.([A-Z])$/, "$1-$2");
      // The server ranks results, so only the top one is opened directly: for
      // "btc" that is Bitcoin (BTC-CAD), not the BTC fund further down.
      const top = results[0];
      const exact =
        top &&
        [normalizedQuery, `${normalizedQuery}-CAD`, `${normalizedQuery}-USD`].includes(
          top.symbol,
        )
          ? top
          : undefined;
      if (exact) {
        await loadSearchResult(exact, false);
      } else if (results.length === 0) {
        setTicketStatus({
          kind: "error",
          message: `No supported listing matched “${query}”.`,
        });
      } else {
        setTicketStatus({
          kind: "idle",
          message: `Found ${results.length} supported ${results.length === 1 ? "listing" : "listings"}. Choose one to load its market price.`,
        });
      }
    } catch (error) {
      setTicketStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "The symbol search failed.",
      });
    } finally {
      setSearching(false);
    }
  };

  const loadSearchResult = async (
    result: Pick<InstrumentSearchResult, "symbol">,
    manageSearching = true,
  ) => {
    const request = ++selectionRequest.current;
    if (manageSearching) setSearching(true);
    setTicketStatus({
      kind: "working",
      message: `Loading ${result.symbol} from the market feed…`,
    });
    try {
      // A fresh price already on the page saves the lookup; the history
      // request that follows returns the quote anyway.
      const held = dashboard.availableSymbols.find(
        (candidate) => candidate.symbol === result.symbol,
      );
      if (held && !held.isStale) {
        selectQuote(held);
        return;
      }
      const response = await fetch(
        `/api/quotes?symbol=${encodeURIComponent(result.symbol)}`,
        { cache: "no-store", credentials: "same-origin" },
      );
      const payload = (await readJson(response)) as { results?: Quote[] } & ApiErrorShape;
      // Another symbol was picked while this one loaded: that pick wins.
      if (request !== selectionRequest.current) return;
      if (!response.ok) {
        throw new Error(extractError(payload, `Could not load ${result.symbol}.`));
      }
      const quote = payload.results?.find(
        (candidate) => candidate.symbol === result.symbol,
      );
      if (!quote) {
        throw new Error(`${result.symbol} is not currently available from the market feed.`);
      }
      selectQuote(quote);
    } catch (error) {
      if (request !== selectionRequest.current) return;
      setTicketStatus({
        kind: "error",
        message: error instanceof Error ? error.message : `Could not load ${result.symbol}.`,
      });
    } finally {
      if (manageSearching) setSearching(false);
    }
  };

  const selectQuote = (quote: Quote) => {
    selectionRequest.current += 1;
    const previousSymbol = selectedSymbolRef.current;
    selectedSymbolRef.current = quote.symbol;
    setSelectedSymbol(quote.symbol);
    setSelectedQuote(quote);
    setSearchQuery("");
    setSearchResults([]);
    setSuggestionsOpen(false);
    setActiveSuggestion(-1);
    setQuoteHistory(null);
    // Prices typed for another listing mean nothing for this one (different
    // currency, scale, or lot size), so they start blank again.
    if (quote.symbol !== previousSymbol) {
      setTriggerPrice("");
      setTakeProfitPrice("");
      setStopLossPrice("");
    }
    setTicketStatus({
      kind: "idle",
      message: `${quote.symbol} loaded from ${marketSourceLabel(quote.source)}.`,
    });
  };

  // A holding's symbol (in the table or on the map) loads it into the quote
  // workbench, from the known prices when possible.
  const openHoldingInWorkbench = (symbol: string) => {
    const quote = dashboard.availableSymbols.find(
      (candidate) => candidate.symbol === symbol,
    );
    if (quote) selectQuote(quote);
    else void loadSearchResult({ symbol });
  };

  const openOwnPortfolioMap = () => {
    mapRequest.current?.abort();
    setMapView({ kind: "own" });
    // Retry reopens from inside the dialog, which is already showing.
    if (!mapDialogRef.current?.open) mapDialogRef.current?.showModal();
  };

  // Hosts and platform admins can open any team's map from the leaderboard.
  const openTeamPortfolioMap = async (teamId: string, teamName: string) => {
    mapRequest.current?.abort();
    const controller = new AbortController();
    mapRequest.current = controller;
    setMapView({
      kind: "team",
      teamId,
      teamName,
      status: "loading",
      holdings: null,
      error: "",
    });
    // Retry reopens from inside the dialog, which is already showing.
    if (!mapDialogRef.current?.open) mapDialogRef.current?.showModal();
    try {
      const response = await fetch(
        `/api/teams/${encodeURIComponent(teamId)}/holdings`,
        { cache: "no-store", credentials: "same-origin", signal: controller.signal },
      );
      const payload = await readJson(response);
      if (controller.signal.aborted) return;
      if (!response.ok) {
        throw new Error(extractError(payload, "That team's holdings could not be loaded."));
      }
      setMapView({
        kind: "team",
        teamId,
        teamName,
        status: "ready",
        holdings: payload as TeamHoldingsView,
        error: "",
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      setMapView({
        kind: "team",
        teamId,
        teamName,
        status: "error",
        holdings: null,
        error:
          error instanceof Error && error.message
            ? error.message
            : "That team's holdings could not be loaded.",
      });
    } finally {
      if (mapRequest.current === controller) mapRequest.current = null;
    }
  };

  const selectMapSymbol = (symbol: string) => {
    openHoldingInWorkbench(symbol);
    mapDialogRef.current?.close();
  };

  // Editing the ticket retires the last result message, so a disabled
  // button always shows why it's disabled for the ticket as it is now.
  const editTicket = () =>
    setTicketStatus((current) =>
      current.kind === "working" || current.kind === "idle"
        ? current
        : { kind: "idle", message: "Ready for a simulated order." },
    );

  // While the key is kept the order may have gone through, so the ticket must
  // be retried unchanged; editing it would make a new order.
  const orderFailureMessage = (error: unknown, fallback: string) => {
    const message = error instanceof Error ? error.message : fallback;
    return pendingOrder.current
      ? `${message} Retry without editing the ticket; it can't be placed twice.`
      : `${message} Check the ticket and try again.`;
  };

  const placeWaitingOrder = async (
    idempotencyKey: string,
    bracket: { takeProfitCents: number | null; stopLossCents: number | null } | undefined,
  ) => {
    if (!isWaitingOrder || triggerPriceCents === null) return;
    try {
      let response: Response;
      try {
        response = await fetch("/api/working-orders", {
          method: "POST",
          signal: AbortSignal.timeout(ORDER_REQUEST_TIMEOUT_MS),
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            side,
            symbol: selectedQuote.symbol,
            quantity: wholeQuantity,
            orderType: ticketOrderType,
            triggerPriceCents,
            timeInForce,
            ...(bracket ? { bracket } : {}),
          }),
        });
      } catch {
        throw new Error("The server didn't answer.");
      }
      const payload = await readJson(response);
      if (!response.ok) {
        if (!orderKeyOutlivesFailure(response.status)) pendingOrder.current = null;
        throw new Error(extractError(payload, "The order could not be placed."));
      }
      const [entry] = (payload as { workingOrders?: WorkingOrderView[] }).workingOrders ?? [];
      if (!entry?.id) {
        throw new Error("The order response was incomplete.");
      }
      pendingOrder.current = null;
      const amount = selectedIsCrypto
        ? `${number.format(entry.quantity)} ${unitWord("CRYPTO", entry.quantity)} of ${entry.symbol}`
        : `${number.format(entry.quantity)} ${entry.symbol}`;
      const label = `${workingOrderName(entry.orderType, entry.side)} for ${amount} at ${formatWorkingOrderPrice(entry)}`;
      // A retry replays the order the first attempt created, which may have
      // filled or ended since; report where it actually stands.
      const stillWaiting = entry.status === "WORKING" || entry.status === "PENDING_PARENT";
      setTicketStatus(
        stillWaiting
          ? {
              kind: "success",
              message: `${label} is waiting ${
                entry.timeInForce === "DAY" && entry.expiresAt
                  ? `until ${formatScheduleInstant(entry.expiresAt)}`
                  : "until it fills or is cancelled"
              }.${entry.reservedCashCents > 0 ? ` ${formatMoney(entry.reservedCashCents)} is set aside for it.` : ""}${
                bracket ? " Its exits start watching once it fills." : ""
              }`,
            }
          : entry.status === "FILLED"
            ? { kind: "success", message: `${label} was placed and has already filled.` }
            : {
                kind: "error",
                message: `${label} was placed but is no longer waiting${
                  entry.statusReason ? `: ${entry.statusReason.replace(/\.$/, "")}` : ""
                }.`,
              },
      );
      setTriggerPrice("");
      setTakeProfitPrice("");
      setStopLossPrice("");
      await fetchDashboard(true);
    } catch (error) {
      setTicketStatus({
        kind: "error",
        message: orderFailureMessage(error, "The order could not be placed."),
      });
      // Show what the team really has waiting, whatever happened.
      void fetchDashboard(true);
    }
  };

  const cancelWaitingOrder = async (order: WorkingOrderView) => {
    setCancellingOrderId(order.id);
    setWorkingOrdersFeedback(null);
    try {
      const response = await fetch(`/api/working-orders/${encodeURIComponent(order.id)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(extractError(payload, "The order could not be cancelled."));
      }
      setWorkingOrdersFeedback({
        kind: "success",
        message: `${workingOrderName(order.orderType, order.side)} for ${order.symbol} cancelled.`,
      });
    } catch (error) {
      setWorkingOrdersFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "The order could not be cancelled.",
      });
    } finally {
      setCancellingOrderId(null);
      await fetchDashboard(true);
    }
  };

  const placeOrder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (tradeBlockedReason) {
      setTicketStatus({ kind: "error", message: tradeBlockedReason });
      return;
    }
    if (buyBlockedReason) {
      buyBlockedRef.current?.showModal();
      return;
    }

    setTicketStatus({
      kind: "working",
      message: isWaitingOrder
        ? `Placing the ${ORDER_TYPE_LABELS[ticketOrderType].toLowerCase()} order…`
        : `Recording ${ACTION_LABELS[action].toLowerCase()} order in the ${isPlatformAdmin ? "private admin" : "shared team"} ledger…`,
    });

    // Reuse the pending key only for a retry of the exact same ticket; any
    // edit to the ticket is a new order with a new key.
    const orderFingerprint = [
      dashboard.currentUser.id,
      selectedQuote.symbol,
      action,
      wholeQuantity,
      ticketOrderType,
      triggerPriceCents ?? "-",
      isWaitingOrder || bracketLegs > 0 ? timeInForce : "-",
      takeProfitCents ?? "-",
      stopLossCents ?? "-",
    ].join("|");
    const idempotencyKey =
      pendingOrder.current?.fingerprint === orderFingerprint
        ? pendingOrder.current.key
        : createIdempotencyKey();
    pendingOrder.current = { key: idempotencyKey, fingerprint: orderFingerprint };
    const bracket =
      bracketLegs > 0
        ? {
            takeProfitCents,
            stopLossCents,
            ...(ticketOrderType === "MARKET" ? { timeInForce } : {}),
          }
        : undefined;

    if (isWaitingOrder) {
      await placeWaitingOrder(idempotencyKey, bracket);
      return;
    }

    try {
      let response: Response;
      try {
        response = await fetch("/api/orders", {
          method: "POST",
          signal: AbortSignal.timeout(ORDER_REQUEST_TIMEOUT_MS),
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            side: action,
            symbol: selectedQuote.symbol,
            quantity: wholeQuantity,
            orderType: "MARKET",
            ...(bracket ? { bracket } : {}),
          }),
        });
      } catch {
        // No response arrived, so the order may or may not have committed.
        // The key is kept: pressing the button again replays safely.
        throw new Error("The server didn't answer.");
      }

      const payload = await readJson(response);
      if (!response.ok) {
        if (!orderKeyOutlivesFailure(response.status)) pendingOrder.current = null;
        throw new Error(extractError(payload, "The order could not be recorded."));
      }
      const result = payload as OrderResult;
      if (!result.order?.id || !Number.isSafeInteger(result.portfolioVersion)) {
        throw new Error("The order response was incomplete.");
      }
      pendingOrder.current = null;
      setTicketStatus({
        kind: "success",
        // Stock wording stays "BUY 1 SHOP.TO"; crypto names its lots and the
        // exact token amount so a per-lot fill price is never misread.
        message: `${result.order.side} ${
          selectedIsCrypto
            ? `${number.format(result.order.quantity)} ${unitWord("CRYPTO", result.order.quantity)} of ${
                result.order.symbol
              } (${tokenAmountLabel(result.order.quantity, selectedLotSize, result.order.symbol)})`
            : `${result.order.quantity} ${result.order.symbol}`
        } filled once at ${formatMoney(result.order.fillPriceCadCents)}${
          selectedIsCrypto ? " per lot" : ""
        }. Portfolio v${result.portfolioVersion}.${
          bracket
            ? ` ${[
                takeProfitCents ? `Take profit at ${ticketPriceText(takeProfitCents)}` : null,
                stopLossCents ? `stop loss at ${ticketPriceText(stopLossCents)}` : null,
              ]
                .filter(Boolean)
                .join(" and ")} ${bracketLegs > 1 ? "are" : "is"} now waiting.`
            : ""
        }`,
      });
      if (bracket) {
        setTakeProfitPrice("");
        setStopLossPrice("");
      }
      await fetchDashboard(true);
    } catch (error) {
      setTicketStatus({
        kind: "error",
        message: orderFailureMessage(error, "The order could not be recorded."),
      });
      // Show what the team really holds, whatever happened.
      void fetchDashboard(true);
    }
  };

  const updateAdminCash = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isPlatformAdmin) return;

    const cashCents = parseCashDraft(adminCashInputValue);
    if (cashCents === null) {
      setAdminCashFeedback({
        kind: "error",
        message:
          "Enter a non-negative CAD amount with no more than two decimal places.",
      });
      return;
    }

    setAdminCashBusy(true);
    setAdminCashFeedback({
      kind: "working",
      message: "Saving your private test balance…",
    });
    try {
      const response = await fetch("/api/admin/trading-account/cash", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ cashCents }),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(extractError(payload, "The admin test cash did not change."));
      }

      setAdminCashDraft(null);
      setAdminCashFeedback({
        kind: "success",
        message: `Admin test cash set to ${formatMoney(cashCents)}.`,
      });
      await fetchDashboard(true, false);
    } catch (error) {
      setAdminCashFeedback({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The admin test cash did not change.",
      });
    } finally {
      setAdminCashBusy(false);
    }
  };

  const resetAdminSandbox = async () => {
    if (!isPlatformAdmin || !dashboard.team) return;
    if (!sandboxResetArmed) {
      setSandboxResetArmed(true);
      return;
    }
    setSandboxResetBusy(true);
    setAdminCashFeedback({ kind: "working", message: "Resetting your test portfolio…" });
    try {
      const response = await fetch("/api/admin/trading-account/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({}),
      });
      const payload = (await readJson(response)) as {
        account?: { cashCents: number };
      } & ApiErrorShape;
      if (!response.ok) {
        throw new Error(extractError(payload, "The test portfolio was not reset."));
      }
      setAdminCashDraft(null);
      setTradeHistory(null);
      setAdminCashFeedback({
        kind: "success",
        message: `Test portfolio reset to ${formatMoney(payload.account?.cashCents ?? 0)} cash.`,
      });
      await fetchDashboard(true, false);
    } catch (error) {
      setAdminCashFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "The test portfolio was not reset.",
      });
    } finally {
      setSandboxResetBusy(false);
      setSandboxResetArmed(false);
    }
  };

  const changeWatchlist = async (symbol: string, watch: boolean) => {
    if (!canKeepWatchlist) return;
    setWatchBusy(symbol);
    setWatchFeedback(null);
    try {
      const response = await fetch(
        watch ? "/api/watchlist" : `/api/watchlist/${encodeURIComponent(symbol)}`,
        {
          method: watch ? "POST" : "DELETE",
          headers: watch ? { "Content-Type": "application/json" } : undefined,
          credentials: "same-origin",
          body: watch ? JSON.stringify({ symbol }) : undefined,
        },
      );
      const payload = (await readJson(response)) as {
        watchlist?: WatchlistItemView[];
      } & ApiErrorShape;
      if (!response.ok || !payload.watchlist) {
        throw new Error(
          extractError(
            payload,
            watch ? `${symbol} was not added to the watchlist.` : `${symbol} was not removed.`,
          ),
        );
      }
      const watchlist = payload.watchlist;
      setDashboard((current) => ({ ...current, watchlist }));
      setWatchFeedback({
        kind: "success",
        message: watch ? `${symbol} added to the watchlist.` : `${symbol} removed from the watchlist.`,
      });
    } catch (error) {
      setWatchFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "The watchlist did not change.",
      });
    } finally {
      setWatchBusy(null);
    }
  };

  const openWatchlistItem = (item: WatchlistItemView) => {
    if (item.quote) selectQuote(item.quote);
    else void loadSearchResult({ symbol: item.symbol });
  };

  const exportHoldings = () => {
    const day = new Date().toISOString().slice(0, 10);
    downloadTextFile(
      `luban-holdings-${day}.csv`,
      holdingsCsv(dashboard.holdings),
      "text/csv;charset=utf-8",
    );
  };

  const updateCompetition = async () => {
    if (!canManageCompetition) return;
    const nextStatus = dashboard.competition.status === "active" ? "paused" : "active";
    setHostBusy(true);
    try {
      const response = await fetch("/api/admin/competition", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(extractError(payload, "The competition state did not change."));
      }
      await fetchDashboard(true);
      setTicketStatus({
        kind: "success",
        message: `Competition ${nextStatus === "active" ? "resumed" : "paused"}.`,
      });
    } catch (error) {
      setTicketStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Host action failed.",
      });
    } finally {
      setHostBusy(false);
    }
  };

  const saveCompetitionSchedule = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canManageCompetition) return;

    const body: Record<string, unknown> = {};

    // The inputs are Eastern wall time, whatever zone the host's computer is in.
    for (const [field, draft] of [
      ["startsAt", scheduleStartDraft],
      ["endsAt", scheduleEndDraft],
    ] as const) {
      if (draft === null || draft === "") continue;
      const iso = zonedInputValueToIso(draft);
      if (!iso) {
        setHostFeedback("Enter complete start and end dates and times.");
        return;
      }
      body[field] = iso;
    }
    if (scheduleCashDraft !== null && scheduleCashDraft !== "") {
      const cashCents = parseCashDraft(scheduleCashDraft);
      if (cashCents === null) {
        setHostFeedback("Enter a valid starting cash amount in dollars.");
        return;
      }
      body.startingCashCents = cashCents;
    }

    if (Object.keys(body).length === 0) {
      setHostFeedback("Change the schedule or starting cash before saving.");
      return;
    }

    setHostBusy(true);
    setHostFeedback("");
    try {
      const response = await fetch("/api/admin/competition", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(extractError(payload, "The schedule could not be saved."));
      }
      setScheduleStartDraft(null);
      setScheduleEndDraft(null);
      setScheduleCashDraft(null);
      setHostFeedback("Competition schedule saved.");
      await fetchDashboard(true, false);
      // The route answers with the fresh overview.
      setAdminOverview(payload as AdminOverview);
    } catch (error) {
      setHostFeedback(
        error instanceof Error ? error.message : "The schedule could not be saved.",
      );
    } finally {
      setHostBusy(false);
    }
  };

  const resetPrototype = async () => {
    if (!canManageCompetition) return;
    if (!resetArmed) {
      setResetArmed(true);
      return;
    }
    setHostBusy(true);
    try {
      const response = await fetch("/api/admin/reset", { method: "POST" });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(extractError(payload, "The demo data could not be reset."));
      }
      knownVersion.current = 0;
      await fetchDashboard(true);
      setAdminOverview(payload as AdminOverview);
      setTicketStatus({
        kind: "success",
        message: "Prototype portfolio data reset to its original state.",
      });
    } catch (error) {
      setTicketStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Reset failed.",
      });
    } finally {
      setHostBusy(false);
      setResetArmed(false);
    }
  };

  const memberRows = isPlatformAdmin
    ? [
        {
          id: dashboard.currentUser.id,
          name: dashboard.currentUser.name,
          role: "Platform administrator",
          presence: "online",
          current: true,
        },
      ]
    : dashboard.team
      ? dashboard.team.memberNames.map((name, index) => {
          const user = dashboard.session.demoUsers.find(
            (candidate) => candidate.name === name,
          );
          return {
            id: user?.id ?? name,
            name,
            role: index === 0 ? "Captain" : index === 1 ? "Trader" : "Analyst",
            presence:
              dashboard.currentUser.name === name
                ? "online"
                : index === 2
                  ? "away"
                  : "online",
            current: dashboard.currentUser.name === name,
          };
        })
      : [
          {
            id: dashboard.currentUser.id,
            name: dashboard.currentUser.name,
            role: isCompetitionHost ? "Competition host" : "Unassigned student",
            presence: "online",
            current: true,
          },
        ];

  return (
    <main className="app-frame">
      <h1 className="sr-only">
        Luban Market Lab {isPlatformAdmin ? "admin test portfolio" : "team portfolio"}{" "}
        simulator
      </h1>
      <a className="skip-link" href="#order-ticket">
        Skip to order ticket
      </a>

      {/* Until the first dashboard arrives the placeholder data stays hidden. */}
      <div
        className="trading-room"
        data-loading={connection === "connecting" || undefined}
        aria-busy={connection === "connecting" || undefined}
      >
        <header className="app-header">
          <a className="brand-lockup" href="#top" aria-label="Luban Market Lab home">
            <LubanMark className="brand-lockup__mark" />
            <LubanWordmark className="brand-lockup__luban" />
            <span className="brand-lockup__product">Market Lab</span>
          </a>

          <div className="competition-lockup" id="top">
            <strong>{dashboard.competition.name}</strong>
            <span className={`state-tag state-tag--${dashboard.competition.phase}`}>
              <span className="state-dot" aria-hidden="true" />
              {dashboard.competition.phase.charAt(0).toUpperCase() +
                dashboard.competition.phase.slice(1)}
            </span>
            <a
              className="guide-link"
              href={SIM_GUIDE_URL}
              target="_blank"
              rel="noopener"
            >
              <BookIcon />
              How to use
              <span className="sr-only"> (opens the guide in a new tab)</span>
            </a>
          </div>

          <div className="header-tools">
          {/* Hosts and admins only; students never see it. */}
          {canManageCompetition ? (
            <HeaderMenu label="Host controls" icon={<LockIcon />}>
              <div className="host-menu">
                <div className="host-status">
                  <div className="host-status__phase" data-phase={dashboard.competition.phase}>
                    <span>Competition</span>
                    <strong>{dashboard.competition.phase}</strong>
                  </div>
                  <div>
                    <span>Your access</span>
                    <strong>{isPlatformAdmin ? "Platform admin" : "Host"}</strong>
                  </div>
                </div>
                <div className="host-actions">
                  <button
                    className="button button--secondary"
                    type="button"
                    onClick={() => void updateCompetition()}
                    disabled={hostBusy || dashboard.competition.status === "ended"}
                  >
                    {dashboard.competition.status === "active" ? <PauseIcon /> : <PlayIcon />}
                    {dashboard.competition.status === "active"
                      ? "Pause trading"
                      : "Resume trading"}
                  </button>
                  {!isManaged ? (
                    <button
                      className={`button button--secondary ${resetArmed ? "button--danger" : ""}`}
                      type="button"
                      onClick={() => void resetPrototype()}
                      disabled={hostBusy}
                    >
                      <RefreshIcon />
                      {resetArmed ? "Confirm reset" : "Reset demo data"}
                    </button>
                  ) : null}
                </div>
                <a className="button button--secondary host-accounts-link" href="/admin/accounts">
                  <UsersIcon />
                  Team &amp; user management
                </a>
                <a className="button button--secondary host-accounts-link" href="/admin/log">
                  <HistoryIcon />
                  Global log
                </a>
                <details className="host-schedule">
                  <summary className="host-schedule__heading">
                    <strong>Competition schedule</strong>
                    <span>
                      Trading is open between the start and end below. It
                      starts and stops automatically.
                    </span>
                  </summary>
                <form
                  className="host-schedule__body"
                  aria-label="Competition schedule"
                  onSubmit={(event) => void saveCompetitionSchedule(event)}
                >
                  <label htmlFor="schedule-start">
                    <span>Start date &amp; time (ET)</span>
                    <input
                      id="schedule-start"
                      type="datetime-local"
                      value={
                        scheduleStartDraft ??
                        isoToZonedInputValue(dashboard.competition.startsAt)
                      }
                      onChange={(event) => setScheduleStartDraft(event.target.value)}
                      disabled={hostBusy}
                    />
                  </label>
                  <label htmlFor="schedule-end">
                    <span>End date &amp; time (ET)</span>
                    <input
                      id="schedule-end"
                      type="datetime-local"
                      value={
                        scheduleEndDraft ?? isoToZonedInputValue(dashboard.competition.endsAt)
                      }
                      onChange={(event) => setScheduleEndDraft(event.target.value)}
                      disabled={hostBusy}
                    />
                  </label>
                  <label htmlFor="schedule-cash">
                    <span>Team starting cash (CAD)</span>
                    <input
                      id="schedule-cash"
                      type="number"
                      min="0"
                      max="1000000000000"
                      step="0.01"
                      inputMode="decimal"
                      value={
                        scheduleCashDraft ??
                        (dashboard.competition.startingCashCents / 100).toFixed(2)
                      }
                      onChange={(event) => setScheduleCashDraft(event.target.value)}
                      disabled={hostBusy || competitionHasTrades}
                    />
                  </label>
                  {competitionHasTrades ? (
                    <p className="host-schedule__note">
                      Starting cash is locked once trading has begun. Set a
                      team&apos;s cash in Team &amp; user management instead.
                    </p>
                  ) : null}
                  <button className="button button--secondary" type="submit" disabled={hostBusy}>
                    Save schedule
                  </button>
                </form>
                </details>
                <AnnouncementForm
                  announcement={dashboard.announcement}
                  onChanged={() => fetchDashboard(true, false)}
                />
                <WrappedPublishForm
                  ended={dashboard.competition.phase === "ended"}
                  published={dashboard.competition.wrappedPublished}
                  onChanged={() => fetchDashboard(true, false)}
                />
                {/* With real sign-in these live in the account menu instead. */}
                {!isManaged && dashboard.currentUser.role === "platform_admin" ? (
                  <a className="button button--secondary host-accounts-link" href="/admin/valuation-lab">
                    <FlaskIcon />
                    Past → Present valuation lab
                  </a>
                ) : null}
                {!isManaged && dashboard.currentUser.role === "platform_admin" ? (
                  <a className="button button--secondary host-accounts-link" href="/admin/feedback">
                    <ChatIcon />
                    User feedback
                  </a>
                ) : null}
                <p className="host-feedback" role="status" aria-live="polite">
                  {hostFeedback}
                </p>
              </div>
            </HeaderMenu>
          ) : null}
          <ThemeToggle />
          <FeedbackButton />
          <ActivityBell
            items={dashboard.recentActivity}
            title={
              isPlatformAdmin
                ? "Test account activity"
                : isCompetitionHost
                  ? "Competition activity"
                  : "Team activity"
            }
            emptyMessage={
              dashboard.currentUser.role === "student" && !dashboard.team
                ? "No team activity is available until a host assigns you to a team."
                : "No activity has been recorded yet."
            }
            showTeamNames={isCompetitionHost}
            storageKey={`luban.activity-seen.${dashboard.currentUser.id}`}
            prompt={
              dashboard.currentUser.needsDisplayName
                ? {
                    title: "Finish setting up your name",
                    detail: `Your team list shows you as “${dashboard.currentUser.name}”.`,
                    actionLabel: "Set name",
                    onAction: () => setNamePrompt("open"),
                  }
                : undefined
            }
          />
          {accountControls ?? (
            <label className="identity-switcher">
              <span>Demo user</span>
              <span className="select-wrap">
                <UserIcon />
                <select
                  value={dashboard.currentUser.id}
                  onChange={(event) => void switchIdentity(event.target.value)}
                  disabled={identityBusy}
                  aria-label="Switch demo user"
                >
                  {dashboard.session.demoUsers.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name}
                    </option>
                  ))}
                </select>
              </span>
            </label>
          )}
          </div>
        </header>

        <AnnouncementBanner announcement={dashboard.announcement} />
        {dashboard.competition.wrappedPublished ? <WrappedBanner /> : null}

        {connectionError ? (
          <div className="connection-banner" role="status">
            <span>{connectionError}</span>
            <button type="button" onClick={() => void fetchDashboard()}>
              Retry now
            </button>
          </div>
        ) : null}

        <div className="trading-grid">
          <section
            className="room-column room-column--portfolio sync-region"
            data-flash={syncFlash}
            aria-labelledby="portfolio-heading"
          >
            <PanelHeading
              id="portfolio-heading"
              title={isPlatformAdmin ? "Admin test portfolio" : "Team portfolio"}
              icon={isPlatformAdmin ? <UserIcon /> : <UsersIcon />}
              aside={
                <span
                  className="version-tag"
                  title={
                    isPlatformAdmin
                      ? "How many times this private test account has changed: every trade or cash adjustment counts once."
                      : "How many times your team's shared portfolio has changed: every trade by anyone on the team, and any change a host makes, counts once. Everyone on the team sees the same number."
                  }
                >
                  {number.format(teamVersion)} {teamVersion === 1 ? "update" : "updates"} ·{" "}
                  {isPlatformAdmin ? "private" : "shared"}
                </span>
              }
            />

            <div className="team-line">
              <span>{isPlatformAdmin ? "Account" : "Team"}</span>
              <strong>
                {isPlatformAdmin
                  ? "Personal test account"
                  : dashboard.team?.name ??
                    (isCompetitionHost ? "Host overview" : "Unassigned")}
              </strong>
              <span
                className={`team-state team-state--${
                  isPlatformAdmin ? "sandbox" : dashboard.team?.status ?? "active"
                }`}
              >
                {isPlatformAdmin
                  ? dashboard.team
                    ? "Personal sandbox"
                    : "Set cash to begin"
                  : dashboard.team
                    ? dashboard.team.status.charAt(0).toUpperCase() +
                      dashboard.team.status.slice(1)
                    : isCompetitionHost
                      ? "View only"
                      : "Needs team"}
              </span>
            </div>

            <section className={summaryStyles.card} aria-label="Portfolio value">
              <div className={summaryStyles.head}>
                <div className={summaryStyles.total}>
                  <span>Total portfolio value (CAD)</span>
                  {/* Cash plus holdings: the same number the leaderboard ranks. */}
                  <strong>{formatMoney(portfolio.totalValueCents)}</strong>
                </div>
                <dl className={summaryStyles.returns}>
                  <div
                    className={summaryStyles.chip}
                    data-trend={trendOf(portfolio.dayChangeCents)}
                  >
                    <dt className={summaryStyles.label}>Daily return</dt>
                    <dd>
                      <ChangeValue cents={portfolio.dayChangeCents} percent={portfolio.dayChangePercent} />
                      <small>
                        <ChangeValue percent={portfolio.dayChangePercent} />
                      </small>
                    </dd>
                  </div>
                  <div
                    className={summaryStyles.chip}
                    data-trend={trendOf(portfolio.totalReturnCents)}
                  >
                    <dt className={summaryStyles.label}>Total return</dt>
                    <dd>
                      <ChangeValue cents={portfolio.totalReturnCents} percent={portfolio.totalReturnPercent} />
                      <small>
                        <ChangeValue percent={portfolio.totalReturnPercent} />
                      </small>
                    </dd>
                  </div>
                </dl>
              </div>

              {/* How the total splits: shares, cash free to spend, and cash
                  held back for waiting buys. Negative parts draw as empty. */}
              <div className={summaryStyles.split}>
                <div className={summaryStyles.bar} aria-hidden="true">
                  {[
                    [summaryStyles.holdings, portfolio.holdingsValueCents],
                    [summaryStyles.buyingPower, portfolio.buyingPowerCents],
                    [summaryStyles.setAside, portfolio.reservedCashCents],
                  ].map(([className, cents], index, parts) => {
                    const whole = parts.reduce(
                      (sum, [, part]) => sum + Math.max(0, Number(part)),
                      0,
                    );
                    const share = whole > 0 ? Math.max(0, Number(cents)) / whole : 0;
                    return share > 0 ? (
                      <span
                        key={index}
                        className={`${summaryStyles.segment} ${className}`}
                        style={{ flexBasis: `${share * 100}%` }}
                      />
                    ) : null;
                  })}
                </div>
                <dl className={summaryStyles.legend}>
                  <div>
                    <dt className={summaryStyles.label}>Holdings</dt>
                    <dd>{formatMoney(portfolio.holdingsValueCents)}</dd>
                  </div>
                  <div>
                    <dt className={summaryStyles.label} data-swatch="buying-power">
                      Buying power
                    </dt>
                    <dd>{formatSignedCash(portfolio.buyingPowerCents)}</dd>
                  </div>
                  {portfolio.reservedCashCents > 0 ? (
                    <div>
                      <dt className={summaryStyles.label} data-swatch="set-aside">
                        Set aside
                        <HelpTip id="help-set-aside" label="What set aside cash means">
                          Cash held back for buys that are waiting to fill. It still
                          counts toward your total, but you can&apos;t spend it until the
                          order fills or is cancelled.
                        </HelpTip>
                      </dt>
                      <dd>{formatMoney(portfolio.reservedCashCents)}</dd>
                    </div>
                  ) : null}
                  {/* Not a slice of the bar: buying power and set aside together. */}
                  <div className={summaryStyles.cash}>
                    <dt className={summaryStyles.label} data-swatch="none">
                      Cash
                    </dt>
                    <dd data-testid="portfolio-cash">{formatSignedCash(portfolio.cashCents)}</dd>
                  </div>
                </dl>
              </div>

              <dl className={summaryStyles.gains}>
                <div>
                  <dt className={summaryStyles.label}>
                    Unrealized
                    <HelpTip id="help-unrealized" label="What unrealized gain means">
                      The gain or loss on shares you still hold: what they are worth now
                      minus what you paid for them. It changes with the price until you sell.
                    </HelpTip>
                  </dt>
                  <dd>
                    <ChangeValue cents={portfolio.unrealizedGainCents} percent={0} />
                    <small>On holdings</small>
                  </dd>
                </div>
                <div>
                  <dt className={summaryStyles.label}>
                    Realized
                    <HelpTip id="help-realized" label="What realized gain means">
                      The gain or loss locked in by selling: each sale&apos;s proceeds minus the
                      average cost of the shares sold.
                    </HelpTip>
                  </dt>
                  <dd>
                    <ChangeValue cents={portfolio.realizedGainCents} percent={0} />
                    <small>From sales</small>
                  </dd>
                </div>
              </dl>

              <div className={summaryStyles.foot}>
                <small data-testid="price-snapshot">
                  Price snapshot {formatTime(portfolio.asOf)}
                </small>
                {isPlatformAdmin ? (
                  <form
                    className={summaryStyles.cashForm}
                    onSubmit={(event) => void updateAdminCash(event)}
                  >
                    <label htmlFor="admin-test-cash" className={summaryStyles.label}>
                      Test cash
                    </label>
                    <input
                      id="admin-test-cash"
                      aria-label="Admin test cash (CAD)"
                      aria-describedby="admin-test-cash-feedback"
                      aria-invalid={adminCashDraftError ? "true" : undefined}
                      type="number"
                      min="0"
                      max="1000000000000"
                      step="0.01"
                      inputMode="decimal"
                      value={adminCashInputValue}
                      onChange={(event) => {
                        setAdminCashDraft(event.target.value);
                        setAdminCashFeedback(null);
                      }}
                      disabled={adminCashBusy}
                    />
                    <button
                      type="submit"
                      disabled={
                        adminCashBusy ||
                        parsedAdminCash === null ||
                        adminCashIsUnchanged
                      }
                    >
                      {adminCashBusy ? "Saving…" : "Set admin cash"}
                    </button>
                    <small
                      id="admin-test-cash-feedback"
                      className={summaryStyles.feedback}
                      data-kind={adminCashDraftError ? "error" : adminCashFeedback?.kind}
                      role={
                        adminCashFeedback
                          ? adminCashFeedback.kind === "error"
                            ? "alert"
                            : "status"
                          : undefined
                      }
                      aria-live={adminCashFeedback ? "polite" : undefined}
                    >
                      {adminCashDraftError ??
                        adminCashFeedback?.message ??
                        "Private test balance"}
                    </small>
                  </form>
                ) : null}
              </div>
            </section>

            <div className="portfolio-views">
            <div
              className="view-tabs"
              role="tablist"
              aria-label="Portfolio views"
              onKeyDown={(event) => {
                const ids = portfolioViews.map((view) => view.id);
                const index = ids.indexOf(activePortfolioView);
                const next =
                  event.key === "ArrowRight"
                    ? ids[(index + 1) % ids.length]
                    : event.key === "ArrowLeft"
                      ? ids[(index - 1 + ids.length) % ids.length]
                      : event.key === "Home"
                        ? ids[0]
                        : event.key === "End"
                          ? ids[ids.length - 1]
                          : null;
                if (!next) return;
                event.preventDefault();
                setPortfolioView(next);
                document.getElementById(`portfolio-tab-${next}`)?.focus();
              }}
            >
              {portfolioViews.map((view) => (
                <button
                  key={view.id}
                  id={`portfolio-tab-${view.id}`}
                  type="button"
                  role="tab"
                  aria-selected={activePortfolioView === view.id}
                  aria-controls={`portfolio-panel-${view.id}`}
                  tabIndex={activePortfolioView === view.id ? 0 : -1}
                  onClick={() => setPortfolioView(view.id)}
                >
                  {view.label}
                  {view.count ? <span className="view-tabs__count">{view.count}</span> : null}
                </button>
              ))}
            </div>

            {activePortfolioView === "chart" ? (
            <section
              className="portfolio-chart"
              id="portfolio-panel-chart"
              role="tabpanel"
              aria-labelledby="portfolio-chart-title"
            >
              <div className="chart-header">
                <h3 id="portfolio-chart-title" className="sr-only">Portfolio value history</h3>
                <div className="range-tabs" aria-label="Portfolio chart range">
                  {["7D", "1M", "ALL"].map((range) => (
                    <button
                      key={range}
                      type="button"
                      aria-pressed={portfolioRange === range}
                      onClick={() => setPortfolioRange(range)}
                    >
                      {range}
                    </button>
                  ))}
                </div>
              </div>
              <LineChart
                points={portfolioRangePoints}
                label={`${portfolioRange} portfolio value chart`}
                compact
              />
            </section>
            ) : null}

            {activePortfolioView === "holdings" ? (
            <section
              className="holdings-section"
              id="portfolio-panel-holdings"
              role="tabpanel"
              aria-labelledby="holdings-heading"
            >
              <div className="subheading-row">
                <h3 id="holdings-heading" className="sr-only">Holdings</h3>
                <span>Ranked by market value</span>
                {dashboard.holdings.length > 0 ? (
                  <button
                    type="button"
                    className="chart-expand"
                    onClick={exportHoldings}
                    aria-label="Export holdings as CSV"
                  >
                    <DownloadIcon />
                    CSV
                  </button>
                ) : null}
                {dashboard.portfolio !== null ? (
                  <button
                    type="button"
                    className="chart-expand portfolio-map-open"
                    aria-haspopup="dialog"
                    onClick={openOwnPortfolioMap}
                  >
                    <TreemapIcon />
                    Map
                  </button>
                ) : null}
              </div>
              {dashboard.holdings.length > 0 ? (
                <div className="table-scroll">
                  <table className="data-table holdings-table">
                    <thead>
                      <tr>
                        <th scope="col">Symbol</th>
                        <th scope="col">{holdingsHaveLots ? "Quantity" : "Shares"}</th>
                        <th scope="col">Avg cost</th>
                        <th scope="col">Price</th>
                        <th scope="col">Market value</th>
                        <th scope="col">Gain/loss</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...dashboard.holdings]
                        .sort((a, b) => b.marketValueCents - a.marketValueCents)
                        .map((holding) => {
                          const holdingIsCrypto = holding.assetClass === "CRYPTO";
                          const holdingTag = assetTagLabel(holding.assetClass);
                          return (
                          <tr key={holding.symbol}>
                            <th scope="row" data-label="Symbol">
                              <button
                                type="button"
                                className="symbol-button"
                                onClick={() => openHoldingInWorkbench(holding.symbol)}
                              >
                                <strong>
                                  {holding.symbol}
                                  {holdingTag ? (
                                    <em className="asset-tag">{holdingTag}</em>
                                  ) : null}
                                </strong>
                                <span>{holding.name}</span>
                              </button>
                            </th>
                            <td data-label={holdingsHaveLots ? "Quantity" : "Shares"}>
                              {holdingsHaveLots
                                ? `${number.format(holding.quantity)} ${unitWord(holding.assetClass, holding.quantity)}`
                                : number.format(holding.quantity)}
                              {holdingIsCrypto ? (
                                <small className="cell-note">
                                  {tokenAmountLabel(
                                    holding.quantity,
                                    holding.lotSize ?? 1,
                                    holding.symbol,
                                  )}
                                </small>
                              ) : null}
                              {holding.quantity < 0 ? (
                                <small className="cell-note">Short</small>
                              ) : null}
                              {holding.reservedQuantity ? (
                                <small className="cell-note">
                                  {number.format(holding.reservedQuantity)} held for waiting sells
                                </small>
                              ) : null}
                            </td>
                            <td data-label="Avg cost">
                              {formatMoney(holding.averageCostCents)}
                              <small className="cell-note">
                                {holding.quantity < 0
                                  ? `${formatMoney(-holding.costBasisCents)} received`
                                  : `${formatMoney(holding.costBasisCents)} paid`}
                              </small>
                            </td>
                            <td data-label="Price">
                              {formatMoney(holding.currentPriceCadCents)}
                              {holdingIsCrypto ? (
                                <small className="cell-note">per lot</small>
                              ) : null}
                            </td>
                            <td data-label="Market value">{formatMoney(holding.marketValueCents)}</td>
                            <td data-label="Gain/loss">
                              <ChangeValue
                                cents={holding.gainLossCents}
                                percent={holding.gainLossPercent}
                              />
                            </td>
                          </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="empty-state">
                  <LockIcon />
                  <p>
                    {isCompetitionHost
                      ? "Hosts can monitor teams but do not trade from a team portfolio."
                      : isPlatformAdmin
                        ? "No holdings yet. Buy a stock to begin building your private test portfolio."
                        : "No holdings yet. Buy a stock to begin building the team portfolio."}
                  </p>
                </div>
              )}
            </section>
            ) : null}

            {activePortfolioView === "orders" ? (
              <section
                className="working-orders-section"
                id="portfolio-panel-orders"
                role="tabpanel"
                aria-labelledby="working-orders-heading"
              >
                <div className="subheading-row">
                  <h3 id="working-orders-heading" className="sr-only">Waiting orders</h3>
                  <span>
                    {openWorkingOrderCount} of {MAX_OPEN_WORKING_ORDERS_PER_TEAM}
                    {isPlatformAdmin ? "" : " · any teammate can cancel"}
                  </span>
                </div>
                {workingOrderRows.length > 0 ? (
                  <div className="table-scroll">
                    <table className="data-table working-orders-table">
                      <thead>
                        <tr>
                          <th scope="col">Order</th>
                          <th scope="col">Quantity</th>
                          <th scope="col">Price</th>
                          <th scope="col">Lasts</th>
                          <th scope="col">
                            <span className="sr-only">Cancel</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {workingOrderRows.map(({ order, attached }) => {
                          const name = workingOrderName(order.orderType, order.side);
                          const orderIsCrypto = order.assetClass === "CRYPTO";
                          return (
                            <tr
                              key={order.id}
                              className={attached ? "working-order--attached" : undefined}
                            >
                              <th scope="row" data-label="Order">
                                <strong>
                                  {attached ? <span aria-hidden="true">↳ </span> : null}
                                  {name} ·{" "}
                                  <button
                                    type="button"
                                    className="symbol-link"
                                    onClick={() => openHoldingInWorkbench(order.symbol)}
                                  >
                                    {order.symbol}
                                  </button>
                                </strong>
                                <small className="cell-note">
                                  {order.status === "PENDING_PARENT"
                                    ? "Starts when the buy fills"
                                    : order.ocoGroupId
                                      ? `Placed by ${order.actorName} · one cancels the other`
                                      : `Placed by ${order.actorName}`}
                                </small>
                              </th>
                              <td data-label="Quantity">
                                {number.format(order.quantity)}{" "}
                                {unitWord(order.assetClass, order.quantity)}
                                {orderIsCrypto ? (
                                  <small className="cell-note">
                                    {tokenAmountLabel(order.quantity, order.lotSize, order.symbol)}
                                  </small>
                                ) : null}
                              </td>
                              <td data-label="Price">
                                {formatWorkingOrderPrice(order)}
                                {order.reservedCashCents > 0 ? (
                                  <small className="cell-note">
                                    {formatMoney(order.reservedCashCents)} set aside
                                  </small>
                                ) : null}
                              </td>
                              <td data-label="Lasts">
                                {order.timeInForce === "DAY" && order.expiresAt
                                  ? `Until ${formatScheduleInstant(order.expiresAt)}`
                                  : "Until cancelled"}
                              </td>
                              <td data-label="">
                                <button
                                  type="button"
                                  className="button button--secondary button--compact"
                                  disabled={cancellingOrderId !== null}
                                  onClick={() => void cancelWaitingOrder(order)}
                                  aria-label={`Cancel ${name.toLowerCase()} for ${order.symbol}`}
                                >
                                  {cancellingOrderId === order.id ? "Cancelling…" : "Cancel"}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="empty-state">
                    <p>
                      No waiting orders. Choose Limit, Stop loss, or Take profit as the order
                      type to set one, or add exits to a buy.
                    </p>
                  </div>
                )}
                {workingOrdersFeedback ? (
                  <p
                    className={`working-orders-feedback ticket-message ticket-message--${workingOrdersFeedback.kind}`}
                    role={workingOrdersFeedback.kind === "error" ? "alert" : "status"}
                  >
                    {workingOrdersFeedback.message}
                  </p>
                ) : null}
              </section>
            ) : null}

            {activePortfolioView === "trades" ? (
            <section
              className="trade-history-section"
              id="portfolio-panel-trades"
              role="tabpanel"
              aria-labelledby="trade-history-heading"
            >
              <div className="subheading-row">
                <h3 id="trade-history-heading" className="sr-only">Trade history</h3>
                <span>
                  {tradeHistoryOpen && tradeHistory
                    ? `Latest ${number.format(tradeRows.length)}`
                    : "Newest first"}
                </span>
                {dashboard.recentOrders.length > 0 ? (
                  <a
                    className="chart-expand"
                    href="/api/orders/export"
                    download
                    aria-label="Export every trade as CSV"
                  >
                    <DownloadIcon />
                    CSV
                  </a>
                ) : null}
              </div>
              {tradeRows.length > 0 ? (
                <TradeHistoryTable
                  orders={tradeRows}
                  showTeam={isCompetitionHost}
                  onSelectSymbol={openHoldingInWorkbench}
                />
              ) : (
                <div className="empty-state">
                  <HistoryIcon />
                  <p>
                    {isCompetitionHost
                      ? "No trades yet in this competition."
                      : "No trades yet. Filled orders appear here with what each sale made or lost."}
                  </p>
                </div>
              )}
              {tradeHistoryError ? (
                <p className="ticket-message ticket-message--error" role="alert">
                  {tradeHistoryError}
                </p>
              ) : null}
              {dashboard.recentOrders.length >= TRADE_HISTORY_PREVIEW ? (
                <button
                  type="button"
                  className="button button--secondary button--compact trade-history-toggle"
                  aria-expanded={tradeHistoryOpen}
                  onClick={() => {
                    setTradeHistoryOpen((open) => !open);
                    setTradeHistoryError("");
                  }}
                >
                  {tradeHistoryOpen
                    ? "Show fewer"
                    : `Show up to ${TRADE_HISTORY_PAGE} trades`}
                </button>
              ) : null}
            </section>
            ) : null}
            </div>

            {isPlatformAdmin ? (
              <aside className="shared-callout shared-callout--private">
                <LockIcon />
                <div>
                  <strong>Private admin sandbox</strong>
                  <p>
                    Your cash, holdings, and orders are isolated from every team and
                    never affect the competition leaderboard.
                  </p>
                  {dashboard.team ? (
                    <div className="sandbox-reset">
                      <button
                        type="button"
                        className={`button button--secondary button--compact${
                          sandboxResetArmed ? " button--danger" : ""
                        }`}
                        onClick={() => void resetAdminSandbox()}
                        onBlur={() => setSandboxResetArmed(false)}
                        disabled={sandboxResetBusy}
                      >
                        <RefreshIcon />
                        {sandboxResetBusy
                          ? "Resetting…"
                          : sandboxResetArmed
                            ? "Confirm reset"
                            : "Reset test portfolio"}
                      </button>
                      {sandboxResetArmed ? (
                        <small role="status">
                          Clears every holding, waiting order, and past trade, and puts back
                          the cash it was funded with. The watchlist stays.
                        </small>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </aside>
            ) : isCompetitionHost ? (
              <aside className="shared-callout">
                <LockIcon />
                <div>
                  <strong>Competition oversight</strong>
                  <p>
                    Hosts can monitor team activity and manage the competition, but
                    cannot trade from this overview.
                  </p>
                </div>
              </aside>
            ) : (
              <aside className="shared-callout">
                <UsersIcon />
                <div>
                  <strong>One shared account</strong>
                  <p>
                    Every teammate’s committed order updates the same ledger. Each
                    action stays attributed to its author.
                  </p>
                </div>
              </aside>
            )}
          </section>

          <section
            className="room-column room-column--workbench sync-region"
            data-flash={syncFlash}
            aria-labelledby="workbench-heading"
          >
            <PanelHeading
              id="workbench-heading"
              title="Quote workbench"
              aside={
                <form className="symbol-search" onSubmit={searchQuotes} role="search">
                  <label className="sr-only" htmlFor="symbol-search">
                    Search supported symbols
                  </label>
                  <input
                    id="symbol-search"
                    value={searchQuery}
                    onChange={(event) => changeSearchQuery(event.target.value)}
                    onKeyDown={handleSearchKeyDown}
                    onFocus={() => {
                      setSuggestionsOpen(true);
                      setPopularWanted(true);
                    }}
                    onClick={() => setSuggestionsOpen(true)}
                    onBlur={() => {
                      setSuggestionsOpen(false);
                      setActiveSuggestion(-1);
                    }}
                    placeholder="Symbol or name"
                    title="Search symbols (press / from anywhere)"
                    aria-keyshortcuts="/"
                    autoComplete="off"
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded={suggestionsOpen && visibleSuggestions.length > 0}
                    aria-controls="symbol-suggestions"
                    aria-activedescendant={
                      suggestionsOpen && activeSuggestion >= 0
                        ? `symbol-suggestion-${activeSuggestion}`
                        : undefined
                    }
                  />
                  <button type="submit" aria-label="Search symbols" disabled={searching}>
                    <SearchIcon />
                  </button>
                  {suggestionsOpen && (searchQuery.trim() || showingPopular) ? (
                    <div className="symbol-suggestions" aria-busy={searching || suggesting}>
                      <ul
                        id="symbol-suggestions"
                        role="listbox"
                        aria-label="Symbol suggestions"
                      >
                        {showingPopular
                          ? popularGroups.map((group) => (
                              <li
                                key={group.title}
                                role="group"
                                aria-labelledby={group.headingId}
                                className="symbol-suggestions__group"
                              >
                                <span
                                  id={group.headingId}
                                  className="symbol-suggestions__heading"
                                >
                                  {group.title}
                                </span>
                                <ul role="none">
                                  {group.results.map(({ result, index }) =>
                                    renderSuggestion(result, index),
                                  )}
                                </ul>
                              </li>
                            ))
                          : visibleSuggestions.map((result, index) =>
                              renderSuggestion(result, index),
                            )}
                      </ul>
                      {!showingPopular && visibleSuggestions.length === 0 ? (
                        <p className="symbol-suggestions__note">
                          {suggesting ? "Searching…" : "No supported listing matches."}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </form>
              }
            />

            <section className="quote-summary" aria-labelledby="quote-heading">
              <p className="quote-meta">
                {selectedAssetTag ? <em className="asset-tag">{selectedAssetTag}</em> : null}
                <span>{selectedIsCrypto ? "Crypto" : selectedQuote.exchange}</span>
                <span aria-hidden="true">·</span>
                <span>{selectedQuote.sector}</span>
                <span className="quote-meta__status">
                  <span
                    className={`quote-meta__dot${
                      selectedIsCrypto || selectedQuote.marketOpen ? " is-open" : ""
                    }`}
                    aria-hidden="true"
                  />
                  {selectedIsCrypto
                    ? "Trades 24/7"
                    : selectedQuote.marketOpen
                      ? "Market open"
                      : "Market closed"}
                  {" · "}
                  {quoteLoaded ? formatTime(selectedQuote.asOf) : "Loading…"}
                </span>
              </p>
              <div className="quote-symbol-block" aria-hidden="true">
                {selectedQuote.symbol.slice(0, 2)}
              </div>
              <div className="quote-identity">
                <h2 id="quote-heading">{selectedQuote.symbol}</h2>
                <span>{selectedQuote.name}</span>
              </div>
              <div className="quote-price">
                <strong>{quoteLoaded ? formatMoney(selectedQuote.priceCadCents) : "—"}</strong>
                <span>{selectedIsCrypto ? "CAD per lot" : "CAD"}</span>
              </div>
              {canKeepWatchlist && quoteLoaded ? (
                <button
                  type="button"
                  className="watch-toggle"
                  aria-pressed={isWatched}
                  disabled={watchBusy !== null || (!isWatched && watchlistFull)}
                  title={
                    !isWatched && watchlistFull
                      ? `The watchlist is full (${MAX_WATCHLIST_ITEMS} symbols).`
                      : isWatched
                        ? "Remove from watchlist"
                        : "Add to watchlist"
                  }
                  onClick={() => void changeWatchlist(selectedQuote.symbol, !isWatched)}
                >
                  <StarIcon filled={isWatched} />
                  {isWatched ? "Watching" : "Watch"}
                </button>
              ) : null}
              {selectedIsCrypto ? (
                <small className="quote-note quote-lot-note">
                  1 lot = {tokenAmountLabel(1, selectedLotSize, selectedQuote.symbol)}
                  {quoteLoaded
                    ? ` · 1 ${selectedToken} ≈ ${formatPerTokenMoney(
                        selectedQuote.priceCadCents,
                        selectedLotSize,
                        "CAD",
                      )} CAD`
                    : ""}
                </small>
              ) : null}
              {quoteLoaded && selectedQuote.listingCurrency === "USD" ? (
                <small className="quote-note">
                  Native quote {formatNativeMoney(selectedQuote.priceCents, "USD")}
                  {selectedIsCrypto ? " per lot" : ""} ·
                  FX {(selectedQuote.fxRateBasisPoints / 10000).toFixed(4)}
                </small>
              ) : null}
              {tradingHaltReason ? (
                <p className="quote-halt" id="quote-halt">
                  <PauseIcon />
                  <span>
                    <strong>Trading paused.</strong> {tradingHaltReason}
                  </span>
                </p>
              ) : null}
              {selectedQuote.buyBlockedReason ? (
                <p className="quote-halt" id="quote-buy-blocked">
                  <LockIcon />
                  <span>
                    <strong>Unavailable to buy.</strong> {selectedQuote.buyBlockedReason}
                  </span>
                </p>
              ) : null}
            </section>

            {/* The day's move, tinted green or red, with where the quote came from. */}
            <div
              className={`quote-band${
                !quoteLoaded
                  ? ""
                  : selectedQuote.priceCadCents >= selectedQuote.previousCloseCadCents
                    ? " quote-band--up"
                    : " quote-band--down"
              }`}
            >
              {quoteLoaded ? (
                <>
                  <span className="quote-band__move">
                    {selectedQuote.priceCadCents >= selectedQuote.previousCloseCadCents
                      ? "▲"
                      : "▼"}{" "}
                    {formatSignedMoney(
                      selectedQuote.priceCadCents - selectedQuote.previousCloseCadCents,
                    )}{" "}
                    today
                  </span>
                  <span>{formatPercent(selectedQuote.changePercent)}</span>
                </>
              ) : (
                <span className="quote-band__status">Connecting to market data</span>
              )}
              <span className="quote-band__meta">
                {quoteLoaded ? (
                  <>Prev close {formatMoney(selectedQuote.previousCloseCadCents)} · </>
                ) : null}
                {selectedQuote.sourceUrl ? (
                  <a href={selectedQuote.sourceUrl} target="_blank" rel="noreferrer">
                    {marketSourceLabel(selectedQuote.source)}
                  </a>
                ) : (
                  marketSourceLabel(selectedQuote.source)
                )}
                {quoteLoaded && selectedQuote.isStale ? " · stale" : ""}
              </span>
            </div>

            <section className="quote-chart" aria-label={`${selectedQuote.symbol} price chart`}>
              <div className="chart-header">
                <div className="range-tabs" aria-label="Quote chart range">
                  {(["1D", "5D", "1M", "3M"] as QuoteRange[]).map((range) => (
                    <button
                      key={range}
                      type="button"
                      aria-pressed={!customWindow && quoteRange === range}
                      onClick={() => selectQuoteRange(range)}
                    >
                      {range}
                    </button>
                  ))}
                </div>
                <button
                  className="chart-expand"
                  type="button"
                  aria-haspopup="dialog"
                  onClick={() => {
                    chartDialogRef.current?.showModal();
                    setChartExpanded(true);
                  }}
                >
                  <ExpandIcon />
                  Advanced view
                </button>
              </div>
              <LineChart
                points={quotePoints}
                label={`${customWindow ? "Custom" : quoteRange} ${selectedQuote.symbol} price`}
                currency={selectedQuote.listingCurrency}
                range={chartFormatRange}
                timeZone={quoteHistory?.exchangeTimeZone}
                loading={historyLoading}
                emptyMessage={historyError || "Not enough market bars are available yet."}
                interactive
                compressGaps
                referenceCents={
                  !customWindow && quoteRange === "1D" && quoteLoaded
                    ? selectedQuote.previousCloseCents
                    : null
                }
              />
              <div className="market-data-note" role="status">
                {quoteHistory ? (
                  <span>
                    {marketSourceLabel(quoteHistory.source)} · {quoteHistory.interval} bars ·
                    through {formatChartTime(
                      quoteHistory.asOf,
                      quoteRange,
                      quoteHistory.exchangeTimeZone,
                    )}
                    {quoteHistory.isStale ? " · stale cached response" : ""}
                  </span>
                ) : (
                  <span>{historyError || "Requesting timestamped market bars…"}</span>
                )}
                {historyError ? (
                  <button
                    type="button"
                    onClick={() => setHistoryRefreshKey((value) => value + 1)}
                  >
                    Retry
                  </button>
                ) : null}
              </div>
            </section>

            <dialog
              ref={chartDialogRef}
              className="chart-dialog"
              aria-labelledby="chart-dialog-title"
              onClose={() => setChartExpanded(false)}
              onClick={(event) => {
                // A click on the backdrop lands on the dialog element itself.
                if (event.target === event.currentTarget) event.currentTarget.close();
              }}
            >
              {chartExpanded ? (
                <div className="chart-dialog__frame">
                  <header className="chart-dialog__header">
                    <div className="chart-dialog__identity">
                      <h2 id="chart-dialog-title">
                        {selectedQuote.name} ({selectedQuote.symbol})
                      </h2>
                      <span>
                        {selectedQuote.exchange} · {selectedQuote.listingCurrency}
                        {selectedIsCrypto ? " per lot" : ""}
                      </span>
                    </div>
                    {quoteLoaded ? (
                      <div className="chart-dialog__price">
                        <strong>
                          {formatNativeMoney(
                            selectedQuote.priceCents,
                            selectedQuote.listingCurrency,
                          )}
                        </strong>
                        <ChangeValue percent={selectedQuote.changePercent} />
                        <small>
                          As of{" "}
                          {formatChartTooltipTime(
                            selectedQuote.asOf,
                            quoteHistory?.exchangeTimeZone ?? "America/Toronto",
                          )}
                        </small>
                      </div>
                    ) : null}
                    <div
                      className="chart-style"
                      role="group"
                      aria-label="Chart style"
                    >
                      {CHART_STYLES.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          aria-pressed={chartStyle === option.value}
                          onClick={() => setChartStyle(option.value)}
                        >
                          <ChartStyleIcon style={option.value} />
                          {option.label}
                        </button>
                      ))}
                    </div>
                    <button
                      className="chart-dialog__close"
                      type="button"
                      aria-label="Close expanded chart"
                      onClick={() => chartDialogRef.current?.close()}
                    >
                      <CloseIcon />
                    </button>
                  </header>
                  <div className="chart-dialog__body">
                    <LineChart
                      points={quotePoints}
                      label={`${customWindow ? "Custom" : quoteRange} ${selectedQuote.symbol} price, expanded`}
                      currency={selectedQuote.listingCurrency}
                      range={chartFormatRange}
                      timeZone={quoteHistory?.exchangeTimeZone}
                      loading={historyLoading}
                      emptyMessage={historyError || "Not enough market bars are available yet."}
                      interactive
                      compressGaps
                      expanded
                      chartStyle={chartStyle}
                      referenceCents={
                        !customWindow && quoteRange === "1D" && quoteLoaded
                          ? selectedQuote.previousCloseCents
                          : null
                      }
                    />
                  </div>
                  <footer className="chart-dialog__footer">
                    <div className="chart-dialog__controls">
                    <div className="range-tabs" aria-label="Expanded chart range">
                      {(["1D", "5D", "1M", "3M"] as QuoteRange[]).map((range) => (
                        <button
                          key={range}
                          type="button"
                          aria-pressed={!customWindow && quoteRange === range}
                          onClick={() => selectQuoteRange(range)}
                        >
                          {range}
                        </button>
                      ))}
                    </div>
                    <span className="chart-dialog__divider" aria-hidden="true" />
                    {datePicker ? (
                      <form
                        className="chart-dates"
                        aria-label="Custom chart dates"
                        onSubmit={applyDatePicker}
                        noValidate
                      >
                        <label>
                          <span className="sr-only">From</span>
                          <input
                            type="date"
                            value={datePicker.from}
                            min={EARLIEST_HISTORY_DATE}
                            max={datePicker.to || torontoToday()}
                            onChange={(event) =>
                              setDatePicker({
                                ...datePicker,
                                from: event.target.value,
                                error: "",
                              })
                            }
                            aria-invalid={datePicker.error ? true : undefined}
                            aria-describedby={
                              datePicker.error ? "chart-dates-error" : undefined
                            }
                          />
                        </label>
                        <label>
                          <span className="sr-only">To</span>
                          <input
                            type="date"
                            value={datePicker.to}
                            min={datePicker.from || EARLIEST_HISTORY_DATE}
                            max={torontoToday()}
                            onChange={(event) =>
                              setDatePicker({
                                ...datePicker,
                                to: event.target.value,
                                error: "",
                              })
                            }
                            aria-invalid={datePicker.error ? true : undefined}
                            aria-describedby={
                              datePicker.error ? "chart-dates-error" : undefined
                            }
                          />
                        </label>
                        <button type="submit" className="chart-dates__action">
                          Apply
                        </button>
                        <button
                          type="button"
                          className="chart-dates__action"
                          onClick={() => setDatePicker(null)}
                        >
                          Cancel
                        </button>
                        {datePicker.error ? (
                          <span className="chart-dates__error" id="chart-dates-error" role="alert">
                            {datePicker.error}
                          </span>
                        ) : null}
                      </form>
                    ) : (
                      <button
                        type="button"
                        className="chart-dates__toggle"
                        aria-pressed={customWindow !== null}
                        onClick={openDatePicker}
                      >
                        <CalendarIcon />
                        {customWindow ? `${customWindow.from} – ${customWindow.to}` : "Dates"}
                      </button>
                    )}
                    <span className="chart-dialog__divider" aria-hidden="true" />
                    <label className="chart-interval">
                      <span>Interval:</span>
                      <select
                        value={activeInterval}
                        onChange={(event) =>
                          setQuoteInterval(event.target.value as QuoteInterval)
                        }
                      >
                        {QUOTE_INTERVALS.map((interval) => (
                          <option
                            key={interval}
                            value={interval}
                            disabled={!availableIntervals.includes(interval)}
                          >
                            {QUOTE_INTERVAL_LABELS[interval]}
                          </option>
                        ))}
                      </select>
                    </label>
                    </div>
                    <span className="chart-kind">
                      {quoteHistory
                        ? `${marketSourceLabel(quoteHistory.source)} · ${quoteHistory.interval} bars · trading gaps compressed`
                        : historyError || "Requesting timestamped market bars…"}
                    </span>
                  </footer>
                </div>
              ) : null}
            </dialog>

            {dashboard.currentUser.needsDisplayName || namePromptOpen ? (
              <DisplayNamePrompt
                userId={dashboard.currentUser.id}
                open={namePromptOpen}
                onClose={() => setNamePrompt("closed")}
                onSaved={() => void fetchDashboard(true)}
              />
            ) : null}

            <dialog
              ref={mapDialogRef}
              className="chart-dialog portfolio-map-dialog"
              aria-labelledby="portfolio-map-title"
              onClose={() => {
                mapRequest.current?.abort();
                mapRequest.current = null;
                setMapView(null);
              }}
              onClick={(event) => {
                // A click on the backdrop lands on the dialog element itself.
                if (event.target === event.currentTarget) event.currentTarget.close();
              }}
            >
              {mapView ? (
                <div className="chart-dialog__frame">
                  <header className="chart-dialog__header">
                    <div className="chart-dialog__identity">
                      <h2 id="portfolio-map-title">
                        {mapView.kind === "team"
                          ? mapView.teamName
                          : dashboard.team?.name ??
                            (isPlatformAdmin ? "Admin test portfolio" : "Portfolio")}{" "}
                        · Portfolio map
                      </h2>
                      <span>
                        {mapView.kind === "team"
                          ? mapView.holdings
                            ? `${formatMoney(mapView.holdings.totalValueCents)} total · as of ${formatTime(mapView.holdings.asOf)}`
                            : "Read-only view of this team's holdings"
                          : `${formatMoney(portfolio.totalValueCents)} total · as of ${formatTime(portfolio.asOf)}`}
                      </span>
                    </div>
                    <button
                      className="chart-dialog__close"
                      type="button"
                      aria-label="Close portfolio map"
                      onClick={() => mapDialogRef.current?.close()}
                    >
                      <CloseIcon />
                    </button>
                  </header>
                  <div className="portfolio-map-dialog__body">
                    {mapView.kind === "own" ? (
                      <PortfolioMap
                        holdings={dashboard.holdings}
                        cashCents={portfolio.cashCents}
                        label={`${dashboard.team?.name ?? "Your"} portfolio map`}
                        onSelectSymbol={selectMapSymbol}
                      />
                    ) : mapView.status === "ready" && mapView.holdings ? (
                      <PortfolioMap
                        holdings={mapView.holdings.holdings}
                        cashCents={mapView.holdings.cashCents}
                        label={`${mapView.teamName} portfolio map`}
                        onSelectSymbol={selectMapSymbol}
                      />
                    ) : mapView.status === "error" ? (
                      <div className="portfolio-map-dialog__status" role="alert">
                        <p>{mapView.error}</p>
                        <button
                          type="button"
                          className="chart-expand"
                          onClick={() =>
                            void openTeamPortfolioMap(mapView.teamId, mapView.teamName)
                          }
                        >
                          <RefreshIcon />
                          Retry
                        </button>
                      </div>
                    ) : (
                      <div className="portfolio-map-dialog__status" role="status">
                        <p>Loading {mapView.teamName}&apos;s holdings…</p>
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
            </dialog>

            <form className="order-ticket" id="order-ticket" onSubmit={placeOrder}>
              <div className="ticket-layout">
                <div className="ticket-inputs">
                  <div className="order-type order-type--select">
                    <span className="ticket-label-row">
                      <label htmlFor="order-action-select">Action</label>
                      <HelpTip id="order-action-help" label="What do the actions mean?">
                        <span className="help-tip__line">
                          <strong>Buy</strong> buys shares for the team to own.
                        </span>
                        <span className="help-tip__line">
                          <strong>Sell</strong> sells shares the team owns.
                        </span>
                        <span className="help-tip__line">
                          <strong>Short</strong> sells borrowed shares, a bet that the price
                          will fall. The team gets the cash now and owes the shares back.
                        </span>
                        <span className="help-tip__line">
                          <strong>Buy to cover</strong> buys the shorted shares back, closing
                          the short. Buying back below the sale price is a gain.
                        </span>
                      </HelpTip>
                    </span>
                    <select
                      id="order-action-select"
                      value={action}
                      onChange={(event) => {
                        const next = event.target.value as TradeAction;
                        setAction(next);
                        editTicket();
                        // Stop loss and take profit only sell what the team owns.
                        if (
                          next !== "SELL" &&
                          (orderType === "STOP_LOSS" || orderType === "TAKE_PROFIT")
                        ) {
                          setOrderType("MARKET");
                        }
                      }}
                    >
                      {(Object.keys(ACTION_LABELS) as TradeAction[]).map((option) => (
                        <option key={option} value={option}>
                          {ACTION_LABELS[option]}
                        </option>
                      ))}
                    </select>
                  </div>
                  {workingOrdersEnabled && (action === "BUY" || action === "SELL") ? (
                    <div className="order-type order-type--select">
                      <span className="ticket-label-row">
                        <label htmlFor="order-type-select">Order type</label>
                        <HelpTip id="order-type-help" label="What do the order types mean?">
                          <span className="help-tip__line">
                            <strong>Market</strong> buys or sells right away at the current price.
                          </span>
                          <span className="help-tip__line">
                            <strong>Limit</strong> waits for your price or better: a limit buy fills
                            at or below it, a limit sell at or above it.
                          </span>
                          <span className="help-tip__line">
                            <strong>Stop loss</strong> sells if the price falls to your stop, to cap
                            a loss. It sells at the next price available, which can be lower if the
                            price drops quickly.
                          </span>
                          <span className="help-tip__line">
                            <strong>Take profit</strong> sells once the price rises to your target,
                            to lock in a gain.
                          </span>
                        </HelpTip>
                      </span>
                      <select
                        id="order-type-select"
                        value={ticketOrderType}
                        onChange={(event) => {
                          setOrderType(event.target.value as TicketOrderType);
                          editTicket();
                        }}
                      >
                        {(side === "BUY" ? BUY_ORDER_TYPES : SELL_ORDER_TYPES).map((type) => (
                          <option key={type} value={type}>
                            {ORDER_TYPE_LABELS[type]}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <div className="order-type">
                      <span>Order type</span>
                      <strong>Market</strong>
                    </div>
                  )}
                {isWaitingOrder ? (
                  <div className="ticket-conditions">
                    <div className="ticket-condition">
                      <label htmlFor="order-trigger-price">
                        {triggerPriceLabel} · {priceInputUnit}
                      </label>
                      <input
                        id="order-trigger-price"
                        inputMode="decimal"
                        autoComplete="off"
                        type="text"
                        value={triggerPrice}
                        onChange={(event) => {
                          setTriggerPrice(event.target.value);
                          editTicket();
                        }}
                        aria-describedby="order-trigger-help"
                      />
                      <small id="order-trigger-help">
                        {ticketOrderType === "STOP_LOSS"
                          ? "Sells if the price falls to this"
                          : ticketOrderType === "TAKE_PROFIT"
                            ? "Sells if the price rises to this"
                            : side === "BUY"
                              ? "Buys at this price or lower"
                              : "Sells at this price or higher"}
                        {quoteLoaded
                          ? ` · now ${currentPriceText}${selectedIsCrypto ? ` per ${selectedToken}` : ""}`
                          : ""}
                        {selectedIsCrypto && triggerPriceCents !== null
                          ? ` · ${formatNativeMoney(triggerPriceCents, selectedQuote.listingCurrency)} per lot`
                          : ""}
                        {triggerParsed.rounded && triggerPriceCents !== null
                          ? ` · rounds to ${ticketPriceText(triggerPriceCents)} (steps of ${priceStepText})`
                          : ""}
                      </small>
                    </div>
                    <div className="ticket-condition">
                      <span className="ticket-label-row">
                        <label htmlFor="order-time-in-force">Time in force</label>
                        <HelpTip id="time-in-force-help" label="What do Day and Good until cancelled mean?">
                          <span className="help-tip__line">
                            <strong>Day</strong> cancels the order at the end of the trading day
                            ({selectedIsCrypto ? "midnight ET for crypto" : "4:00 p.m. ET"}) if it
                            hasn&apos;t filled. Placed after the close, it lasts through the next
                            trading day.
                          </span>
                          <span className="help-tip__line">
                            <strong>Good until cancelled</strong> keeps it waiting until it fills,
                            someone on your team cancels it, or the competition ends.
                          </span>
                        </HelpTip>
                      </span>
                      <select
                        id="order-time-in-force"
                        value={timeInForce}
                        onChange={(event) => {
                          setTimeInForce(event.target.value as TimeInForce);
                          editTicket();
                        }}
                      >
                        <option value="DAY">Day</option>
                        <option value="GTC">Good until cancelled</option>
                      </select>
                      <small>
                        {timeInForce === "DAY"
                          ? `Ends ${formatScheduleInstant(
                              workingOrderExpiresAt(
                                "DAY",
                                selectedAssetClass,
                                new Date(dashboard.serverTime),
                                selectedQuote.listingCurrency,
                              ) ?? "",
                            )} if not filled`
                          : "Waits until it fills or is cancelled"}
                      </small>
                    </div>
                  </div>
                ) : null}
                  <div className="ticket-quantity">
                    <label htmlFor="order-quantity">
                      <span>Quantity · {selectedIsCrypto ? "Lots" : "Shares"}</span>
                    </label>
                    <button
                      type="button"
                      className="ticket-max"
                      disabled={!quoteLoaded || maxOrderQuantity < 1}
                      aria-haspopup="dialog"
                      onClick={() => maxConfirmRef.current?.showModal()}
                      title={
                        action === "COVER"
                          ? `Buy back every ${unitWord(selectedAssetClass, 1)} sold short`
                          : action === "SHORT"
                            ? `Short as many ${unitWord(selectedAssetClass, 2)} as the one-holding limit allows`
                            : action === "BUY"
                              ? `Buy as many ${unitWord(selectedAssetClass, 2)} as the cash allows`
                              : `Sell every ${unitWord(selectedAssetClass, 1)} held`
                      }
                    >
                      {action === "BUY" || action === "SHORT" ? "Max" : "All"}
                      {quoteLoaded && maxOrderQuantity > 0
                        ? ` · ${number.format(maxOrderQuantity)}`
                        : ""}
                    </button>
                    <dialog
                      ref={maxConfirmRef}
                      className="confirm-dialog"
                      role="alertdialog"
                      aria-labelledby="max-confirm-title"
                      aria-describedby="max-confirm-body"
                      onClick={(event) => {
                        if (event.target === event.currentTarget) event.currentTarget.close();
                      }}
                    >
                      <h2 id="max-confirm-title">
                        {action === "COVER"
                          ? "Cover the whole short?"
                          : action === "SHORT"
                            ? "Short the maximum?"
                            : action === "BUY"
                              ? "Buy the maximum?"
                              : "Sell everything?"}
                      </h2>
                      <div id="max-confirm-body">
                        <p>
                          {action !== "SELL" ? (
                            <>
                              This sets the quantity to{" "}
                              <strong>
                                {number.format(maxOrderQuantity)}{" "}
                                {unitWord(selectedAssetClass, maxOrderQuantity)} of{" "}
                                {selectedQuote.symbol}
                              </strong>
                              , about{" "}
                              <strong>{formatMoney(maxOrderQuantity * ticketUnitCadCents)}</strong>.
                              {action === "COVER" ? (
                                <> That buys back every {unitWord(selectedAssetClass, 1)} sold short.</>
                              ) : action === "SHORT" ||
                                buyLimitCents < portfolio.buyingPowerCents ? (
                                <>
                                  That&rsquo;s as much as the {MAX_POSITION_PERCENT}% limit on one
                                  holding allows.
                                </>
                              ) : (
                                <>
                                  That uses nearly all of the{" "}
                                  {formatMoney(portfolio.buyingPowerCents)} in buying power.
                                </>
                              )}
                            </>
                          ) : (
                            <>
                              This sets the quantity to all{" "}
                              <strong>
                                {number.format(maxOrderQuantity)}{" "}
                                {unitWord(selectedAssetClass, maxOrderQuantity)} of{" "}
                                {selectedQuote.symbol}
                              </strong>{" "}
                              that can be sold, about{" "}
                              <strong>{formatMoney(maxOrderQuantity * ticketUnitCadCents)}</strong>.
                              The whole position would be closed.
                            </>
                          )}
                        </p>
                        <p className="confirm-dialog__note">
                          Nothing is {side === "BUY" ? "bought" : "sold"} until you place the
                          order.
                        </p>
                      </div>
                      <div className="confirm-dialog__actions">
                        <button
                          type="button"
                          className="button button--secondary"
                          autoFocus
                          onClick={() => maxConfirmRef.current?.close()}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="button button--primary"
                          onClick={() => {
                            setQuantity(String(maxOrderQuantity));
                            editTicket();
                            maxConfirmRef.current?.close();
                            document.getElementById("order-quantity")?.focus();
                          }}
                        >
                          Use {number.format(maxOrderQuantity)}{" "}
                          {unitWord(selectedAssetClass, maxOrderQuantity)}
                        </button>
                      </div>
                    </dialog>
                    <input
                      id="order-quantity"
                      inputMode="numeric"
                      min="1"
                      max="100000"
                      step="1"
                      type="number"
                      value={quantity}
                      onChange={(event) => {
                        setQuantity(event.target.value);
                        editTicket();
                      }}
                      aria-describedby={
                        selectedIsCrypto
                          ? `quantity-help quantity-tokens${tradingHaltReason ? " quote-halt" : ""}`
                          : `quantity-help${tradingHaltReason ? " quote-halt" : ""}`
                      }
                    />
                    <small id="quantity-help">
                      {selectedIsCrypto
                        ? `Whole lots only · 1 lot = ${tokenAmountLabel(1, selectedLotSize, selectedQuote.symbol)}`
                        : "Whole shares only"}
                    </small>
                    {selectedIsCrypto ? (
                      <small id="quantity-tokens" className="quantity-tokens">
                        {quantityIsValid
                          ? `= ${tokenAmountLabel(wholeQuantity, selectedLotSize, selectedQuote.symbol)}`
                          : `Enter lots to see the ${selectedToken} amount`}
                      </small>
                    ) : null}
                  </div>

                  {bracketAllowed ? (
                    exitsShown ? (
                      <div
                        className="ticket-bracket"
                        id="ticket-exits"
                        role="group"
                        aria-labelledby="bracket-heading"
                      >
                        <div className="ticket-label-row ticket-bracket__title">
                          <span id="bracket-heading">Exits for this buy</span>
                          <HelpTip id="bracket-help" label="What are take profit and stop loss?">
                            <span className="help-tip__line">
                              <strong>Take profit</strong> sells these {unitWord(selectedAssetClass, 2)}{" "}
                              automatically if the price rises to the level you set, locking in a gain.
                            </span>
                            <span className="help-tip__line">
                              <strong>Stop loss</strong> sells them automatically if the price falls to
                              the level you set, capping a loss.
                            </span>
                            <span className="help-tip__line">
                              Set either, both, or neither. With both, whichever fills first cancels the
                              other.
                              {ticketOrderType === "LIMIT"
                                ? " They start watching once the limit buy fills."
                                : " They start watching as soon as the buy fills."}
                            </span>
                          </HelpTip>
                          <button
                            type="button"
                            className="ticket-exits__remove"
                            onClick={() => {
                              setTakeProfitPrice("");
                              setStopLossPrice("");
                              setExitsOpen(false);
                              editTicket();
                              window.requestAnimationFrame(() =>
                                document.getElementById("ticket-exits-add")?.focus(),
                              );
                            }}
                          >
                            Remove
                          </button>
                        </div>
                        <div className="ticket-condition">
                          <label htmlFor="bracket-take-profit">
                            Take profit <em className="optional-note">(optional)</em>
                          </label>
                          <input
                            id="bracket-take-profit"
                            inputMode="decimal"
                            autoComplete="off"
                            type="text"
                            placeholder={priceInputUnit}
                            value={takeProfitPrice}
                            onChange={(event) => {
                              setTakeProfitPrice(event.target.value);
                              editTicket();
                            }}
                          />
                          {takeProfitParsed.rounded && takeProfitCents !== null ? (
                            <small>Rounds up to {ticketPriceText(takeProfitCents)}</small>
                          ) : null}
                        </div>
                        <div className="ticket-condition">
                          <label htmlFor="bracket-stop-loss">
                            Stop loss <em className="optional-note">(optional)</em>
                          </label>
                          <input
                            id="bracket-stop-loss"
                            inputMode="decimal"
                            autoComplete="off"
                            type="text"
                            placeholder={priceInputUnit}
                            value={stopLossPrice}
                            onChange={(event) => {
                              setStopLossPrice(event.target.value);
                              editTicket();
                            }}
                          />
                          {stopLossParsed.rounded && stopLossCents !== null ? (
                            <small>Rounds down to {ticketPriceText(stopLossCents)}</small>
                          ) : null}
                        </div>
                        {ticketOrderType === "MARKET" && (takeProfitEntered || stopLossEntered) ? (
                          <div className="ticket-condition ticket-condition--wide">
                            <span className="ticket-label-row">
                              <label htmlFor="bracket-time-in-force">Exits last</label>
                              <HelpTip
                                id="bracket-time-in-force-help"
                                label="What do Day and Good until cancelled mean?"
                              >
                                <span className="help-tip__line">
                                  <strong>Day</strong> cancels the exits at the end of the trading day
                                  ({selectedIsCrypto ? "midnight ET for crypto" : "4:00 p.m. ET"}) if
                                  they haven&apos;t filled.
                                </span>
                                <span className="help-tip__line">
                                  <strong>Good until cancelled</strong> keeps them waiting until one
                                  fills, someone on your team cancels them, or the competition ends.
                                </span>
                              </HelpTip>
                            </span>
                            <select
                              id="bracket-time-in-force"
                              value={timeInForce}
                              onChange={(event) => {
                                setTimeInForce(event.target.value as TimeInForce);
                                editTicket();
                              }}
                            >
                              <option value="DAY">Day</option>
                              <option value="GTC">Good until cancelled</option>
                            </select>
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="ticket-exits__add"
                        id="ticket-exits-add"
                        onClick={() => {
                          setExitsOpen(true);
                          window.requestAnimationFrame(() =>
                            document.getElementById("bracket-take-profit")?.focus(),
                          );
                        }}
                      >
                        <PlusIcon />
                        Add take profit or stop loss
                      </button>
                    )
                  ) : null}
                </div>

                <div className="ticket-receipt" aria-label="Order summary" role="group">
                  <dl>
                    <div>
                      <dt>
                        {isWaitingOrder
                          ? selectedIsCrypto
                            ? "Price per lot now"
                            : "Price now"
                          : selectedIsCrypto
                            ? "Estimated fill per lot"
                            : "Estimated fill"}
                      </dt>
                      <dd>{quoteLoaded ? formatMoney(selectedQuote.priceCadCents) : "—"}</dd>
                    </div>
                    <div>
                      <dt>× {selectedIsCrypto ? "Lots" : "Shares"}</dt>
                      <dd>{quantityIsValid ? number.format(wholeQuantity) : "—"}</dd>
                    </div>
                    <div className="ticket-receipt__total">
                      <dt>
                        {setsAsideCash
                          ? "Cash set aside"
                          : isWaitingOrder
                            ? "Value at your price"
                            : "Estimated total"}
                      </dt>
                      <dd>
                        {quoteLoaded && quantityIsValid && (!isWaitingOrder || triggerPriceCents !== null)
                          ? formatMoney(estimatedValue)
                          : "—"}
                      </dd>
                      <dd className="ticket-receipt__note">
                        {setsAsideCash && selectedQuote.listingCurrency === "USD"
                          ? "Includes a 2% cushion for USD/CAD moves"
                          : `$0.00 simulated commission · ${
                              quoteLoaded
                                ? `${marketSourceLabel(selectedQuote.source)} snapshot`
                                : "waiting for market data"
                            }`}
                      </dd>
                    </div>
                    {action === "BUY" ? (
                      <div
                        className={
                          receiptCashLeft !== null && receiptCashLeft < 0
                            ? "ticket-receipt__after is-short"
                            : "ticket-receipt__after"
                        }
                      >
                        <dt>{receiptCashLeft !== null ? "Cash left" : "Cash available"}</dt>
                        <dd>
                          {receiptCashLeft !== null
                            ? formatSignedCash(receiptCashLeft)
                            : formatMoney(portfolio.buyingPowerCents)}
                        </dd>
                        <dd className="ticket-receipt__sub">
                          {receiptCashLeft !== null
                            ? `of ${formatMoney(portfolio.buyingPowerCents)} available`
                            : isPlatformAdmin
                              ? "Admin test account"
                              : "Team account"}
                          {portfolio.reservedCashCents > 0
                            ? ` · ${formatMoney(portfolio.reservedCashCents)} set aside for waiting buys`
                            : ""}
                        </dd>
                      </div>
                    ) : (
                      <div
                        className={
                          quantityIsValid &&
                          ((action === "SELL" && wholeQuantity > freeQuantity) ||
                            (action === "COVER" && wholeQuantity > shortQuantity) ||
                            (action === "SHORT" && heldQuantity > 0))
                            ? "ticket-receipt__after is-short"
                            : "ticket-receipt__after"
                        }
                      >
                        <dt>
                          {quantityIsValid
                            ? positionAfter < 0
                              ? "Short after"
                              : `${selectedIsCrypto ? "Lots" : "Shares"} left`
                            : heldQuantity < 0
                              ? "Short"
                              : reservedQuantity > 0
                              ? "Free to sell"
                              : selectedIsCrypto
                                ? "Lots held"
                                : "Shares held"}
                        </dt>
                        <dd>
                          {number.format(
                            quantityIsValid
                              ? action === "SELL"
                                ? freeQuantity - wholeQuantity
                                : positionAfter
                              : heldQuantity < 0
                                ? heldQuantity
                                : freeQuantity,
                          )}
                        </dd>
                        <dd className="ticket-receipt__sub">
                          {heldQuantity < 0
                            ? `${selectedQuote.symbol} sold short`
                            : reservedQuantity > 0
                            ? `${number.format(heldQuantity)} held · ${number.format(reservedQuantity)} held back for waiting sells`
                            : selectedIsCrypto
                              ? `${selectedQuote.symbol} · ${tokenAmountLabel(heldQuantity, selectedLotSize, selectedQuote.symbol)}`
                              : `of ${number.format(freeQuantity)} ${selectedQuote.symbol} held`}
                        </dd>
                      </div>
                    )}
                  </dl>
                  <button
                    className={`button button--primary ${side === "SELL" ? "button--sell" : ""}`}
                    type="submit"
                    disabled={!canTrade || ticketStatus.kind === "working"}
                    aria-describedby="ticket-status"
                  >
                    {ticketStatus.kind === "working"
                      ? "Recording order…"
                      : isWaitingOrder
                        ? `Place ${ORDER_TYPE_LABELS[ticketOrderType].toLowerCase()} order`
                        : action === "SHORT"
                          ? "Place short sale"
                          : action === "COVER"
                            ? "Place buy to cover"
                            : `Place simulated ${side.toLowerCase()}`}
                    <ArrowIcon />
                  </button>
                  <dialog
                    ref={buyBlockedRef}
                    className="confirm-dialog"
                    role="alertdialog"
                    aria-labelledby="buy-blocked-title"
                    aria-describedby="buy-blocked-body"
                    onClick={(event) => {
                      if (event.target === event.currentTarget) event.currentTarget.close();
                    }}
                  >
                    <h2 id="buy-blocked-title">
                      Can&rsquo;t {action === "SHORT" ? "short" : "buy"} {selectedQuote.symbol}
                    </h2>
                    <p id="buy-blocked-body">{buyBlockedReason}</p>
                    <div className="confirm-dialog__actions">
                      <button
                        type="button"
                        className="button button--primary"
                        autoFocus
                        onClick={() => buyBlockedRef.current?.close()}
                      >
                        OK
                      </button>
                    </div>
                  </dialog>
                  <button
                    className="ticket-receipt__clear"
                    type="button"
                    onClick={() => {
                      setQuantity("");
                      setTriggerPrice("");
                      setTakeProfitPrice("");
                      setStopLossPrice("");
                      setExitsOpen(false);
                      setTicketStatus({ kind: "idle", message: "Order ticket cleared." });
                    }}
                  >
                    Clear ticket
                  </button>
                </div>
              </div>

              <div
                id="ticket-status"
                className={`ticket-message ticket-message--${displayedTicketStatus.kind}`}
                role="status"
                aria-live="polite"
              >
                <InfoIcon />
                <span>{displayedTicketStatus.message}</span>
              </div>

              <aside className="order-disclosure">
                Orders are simulated and fill once at the server’s latest available market
                snapshot.{workingOrdersEnabled
                  ? " Waiting orders are checked about once a minute while their market is open."
                  : ""}{" "}
                No brokerage order is sent. Past performance does not predict future results.
              </aside>
            </form>
          </section>

          <aside className="room-column room-column--team" aria-label="Team room and competition">
            {canKeepWatchlist ? (
              <AnimatedRailSection
                className="watchlist-section"
                headingId="watchlist-heading"
                contentId="watchlist-content"
                title={isPlatformAdmin ? "Watchlist" : "Team watchlist"}
                icon={<StarIcon />}
                aside={
                  <span>
                    {dashboard.watchlist.length} of {MAX_WATCHLIST_ITEMS}
                  </span>
                }
                isOpen={openRailSections.watchlist}
                onToggle={() => toggleRailSection("watchlist")}
              >
                {dashboard.watchlist.length > 0 ? (
                  <WatchlistTable
                    items={dashboard.watchlist}
                    selectedSymbol={selectedQuote.symbol}
                    busySymbol={watchBusy}
                    idle={marketsIdle}
                    onOpen={openWatchlistItem}
                    onRemove={(symbol) => void changeWatchlist(symbol, false)}
                  />
                ) : (
                  <p className="watchlist-empty">
                    Press <strong>Watch</strong> beside a quote&apos;s price to keep an eye on
                    it here.{isPlatformAdmin ? "" : " Everyone on your team sees the same list."}
                  </p>
                )}
                {watchFeedback ? (
                  <p
                    className={`watchlist-feedback ticket-message ticket-message--${watchFeedback.kind}`}
                    role={watchFeedback.kind === "error" ? "alert" : "status"}
                  >
                    {watchFeedback.message}
                  </p>
                ) : null}
              </AnimatedRailSection>
            ) : null}
            <AnimatedRailSection
              className="presence-section"
              headingId="presence-heading"
              contentId="presence-content"
              title={
                isPlatformAdmin
                  ? "Admin test account"
                  : `Team presence (${memberRows.length})`
              }
              icon={<span className="presence-signal" aria-hidden="true" />}
              isOpen={openRailSections.presence}
              onToggle={() => toggleRailSection("presence")}
            >
              <ul className="presence-list">
                {memberRows.map((member) => (
                  <li key={member.id}>
                    <span
                      className={`presence-dot presence-dot--${member.presence}`}
                      role="img"
                      aria-label={`${member.presence} presence`}
                    />
                    <span>
                      {member.name} {member.current ? <strong>(You)</strong> : null}
                    </span>
                    <small>{member.role}</small>
                  </li>
                ))}
              </ul>
            </AnimatedRailSection>

            <AnimatedRailSection
              className="leaderboard-section sync-region"
              headingId="leaderboard-heading"
              contentId="leaderboard-content"
              title="Competition leaderboard"
              aside={<span>Fair snapshot</span>}
              isOpen={openRailSections.leaderboard}
              onToggle={() => toggleRailSection("leaderboard")}
              data-flash={syncFlash}
            >
              <div className="table-scroll">
                <LeaderboardTable
                  rows={rows}
                  canOpenAnyMap={canManageCompetition}
                  onOpenMap={(row) =>
                    canManageCompetition
                      ? void openTeamPortfolioMap(row.teamId, row.teamName)
                      : openOwnPortfolioMap()
                  }
                />
              </div>
              <p className="snapshot-note">
                Every team is valued from the same cached market-data snapshot.
              </p>
            </AnimatedRailSection>

          </aside>
        </div>

        <footer className="status-footer">
          <div>
            <PulseIcon />
            <strong>Local ledger</strong>
            <span className={`connection-state connection-state--${connection}`}>
              {connection.charAt(0).toUpperCase() + connection.slice(1)}
            </span>
            <span
              className="status-cadence"
              data-team-sync-ms={TEAM_SYNC_INTERVAL_MS}
              data-market-refresh-ms={MARKET_REFRESH_INTERVAL_MS}
            >
              <span>{`Team ledger every ${marketsIdle ? "5 minutes" : "2 minutes"}`}</span>
              <span>{`Market prices every ${marketsIdle ? "5 minutes" : "2 minutes"}`}</span>
            </span>
          </div>
          <div>
            <span>Base currency</span>
            <strong>{dashboard.competition.baseCurrency}</strong>
          </div>
          <div>
            <span>Last team sync</span>
            <strong>{formatTime(dashboard.serverTime)}</strong>
          </div>
          <div className="status-footer__credits">
            <span>
              Version{" "}
              <a
                className="status-footer__version"
                href="/changelog"
                title="See what's new in each release"
              >
                <strong>v{APP_VERSION}</strong>
              </a>
              {APP_COMMIT ? <span className="status-footer__commit"> · {APP_COMMIT}</span> : null}
            </span>
            <span className="status-footer__maker">
              Made by <strong>Joseph Wang</strong>
              <span className="status-footer__social">
                {MAKER_LINKS.map((link) => (
                  <a
                    key={link.label}
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Joseph Wang on ${link.label} (opens in a new tab)`}
                    title={link.label}
                  >
                    {link.icon}
                  </a>
                ))}
              </span>
            </span>
          </div>
        </footer>

        <div className="sr-only" role="status" aria-live="polite">
          {syncFlash
            ? `Shared portfolio updated. ${number.format(teamVersion)} ${teamVersion === 1 ? "update" : "updates"} so far.`
            : ""}
        </div>
      </div>
    </main>
  );
}
