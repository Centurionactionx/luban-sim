"use client";

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
  PopularSection,
  Leaderboard,
  LeaderboardRow,
  PortfolioPoint,
  PortfolioSummary,
  Quote,
  QuoteHistory,
  QuoteRange,
  SessionUser,
  TeamHoldingsView,
  TeamSummary,
  TeamStatus,
  TimeInForce,
  TradeSide,
  WorkingOrderType,
  WorkingOrderView,
} from "@/lib/contracts";
import {
  cryptoTokenSymbol,
  formatTokenQuantity,
  lotExponentFromSize,
  unitWord,
} from "@/lib/lots";
import { priceInputToCents, reservedCadCentsPerUnit } from "@/lib/order-math";
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
  MARKET_REFRESH_INTERVAL_MS,
  TEAM_SYNC_INTERVAL_MS,
} from "@/lib/market-config";
import {
  ArrowIcon,
  BellIcon,
  BookIcon,
  CashIcon,
  ChevronDownIcon,
  CalendarIcon,
  CloseIcon,
  ExpandIcon,
  FlaskIcon,
  InfoIcon,
  LockIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PulseIcon,
  RefreshIcon,
  SearchIcon,
  TreemapIcon,
  UserIcon,
  UsersIcon,
} from "./simulator-icons";
import { PortfolioMap } from "./portfolio-map";

type DashboardPayload = Omit<Dashboard, "leaderboard"> & {
  leaderboard: LeaderboardRow[] | Leaderboard;
  session: {
    user: SessionUser;
    demoUsers: DemoUser[];
  };
};

type RailSectionId = "presence" | "leaderboard" | "host";

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
type TeamEditorField = "name" | "cash";

const INITIAL_RAIL_SECTIONS: Record<RailSectionId, boolean> = {
  presence: true,
  leaderboard: true,
  host: true,
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

type ApiErrorShape = {
  error?: {
    code?: string;
    message?: string;
    field?: string;
  };
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
  asOf: FIXED_NOW,
};

const currency = new Intl.NumberFormat("en-CA", {
  style: "currency",
  currency: "CAD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const number = new Intl.NumberFormat("en-CA");
const TEAM_NAME_MAX_LENGTH = 80;
const MAX_SUGGESTIONS = 8;
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
const SUGGESTION_DELAY_MS = 120;

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

function cashDraftsForOverview(overview: AdminOverview): Record<string, string> {
  return Object.fromEntries(
    overview.teams.map((team) => [team.id, (team.cashCents / 100).toFixed(2)]),
  );
}

function nameDraftsForOverview(overview: AdminOverview): Record<string, string> {
  return Object.fromEntries(overview.teams.map((team) => [team.id, team.name]));
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

function leaderboardRows(value: DashboardPayload["leaderboard"]): LeaderboardRow[] {
  return Array.isArray(value) ? value : value.rows;
}

function extractError(payload: unknown, fallback: string): string {
  if (typeof payload === "object" && payload !== null) {
    const error = (payload as ApiErrorShape).error;
    if (error && typeof error.message === "string") return error.message;
  }
  return fallback;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
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

const ORDER_TYPE_LABELS: Record<TicketOrderType, string> = {
  MARKET: "Market",
  LIMIT: "Limit",
  STOP_LOSS: "Stop loss",
  TAKE_PROFIT: "Take profit",
};
const BUY_ORDER_TYPES: TicketOrderType[] = ["MARKET", "LIMIT"];
const SELL_ORDER_TYPES: TicketOrderType[] = ["MARKET", "LIMIT", "STOP_LOSS", "TAKE_PROFIT"];
const MAX_WAITING_ORDERS = 20;
const MAX_ORDER_PRICE_CENTS = 10_000_000_000;

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

function ActivityBell({
  items,
  title,
  emptyMessage,
  showTeamNames,
  storageKey,
}: {
  items: ActivityItem[];
  title: string;
  emptyMessage: string;
  showTeamNames: boolean;
  storageKey: string;
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
  const unseen = items.filter((item) => Date.parse(item.createdAt) > seenMs).length;

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

function ChangeValue({ cents, percent }: { cents?: number; percent: number }) {
  const value = cents ?? percent;
  const className = value >= 0 ? "change change--positive" : "change change--negative";
  return (
    <span className={className}>
      {cents === undefined ? formatPercent(percent) : formatSignedMoney(cents)}
    </span>
  );
}

export interface SimulatorAppProps {
  /** demo (default): seeded identities and the identity switcher. */
  authMode?: AuthMode;
  /** Rendered in the header instead of the demo identity switcher. */
  accountControls?: ReactNode;
}

export function SimulatorApp({
  authMode = "demo",
  accountControls,
}: SimulatorAppProps = {}) {
  const isManaged = authMode === "managed";
  const router = useRouter();
  const [dashboard, setDashboard] = useState<DashboardPayload>(fallbackDashboard);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [sessionReady, setSessionReady] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [selectedSymbol, setSelectedSymbol] = useState("SHOP.TO");
  const [selectedQuote, setSelectedQuote] = useState<Quote>(fallbackQuotes[0]);
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
  const [side, setSide] = useState<TradeSide>("BUY");
  const [quantity, setQuantity] = useState("10");
  const [orderType, setOrderType] = useState<TicketOrderType>("MARKET");
  const [triggerPrice, setTriggerPrice] = useState("");
  const [timeInForce, setTimeInForce] = useState<TimeInForce>("GTC");
  // Bracket exits start blank: they are optional.
  const [takeProfitPrice, setTakeProfitPrice] = useState("");
  const [stopLossPrice, setStopLossPrice] = useState("");
  const [cancellingOrderId, setCancellingOrderId] = useState<string | null>(null);
  const [workingOrdersFeedback, setWorkingOrdersFeedback] = useState<TicketStatus | null>(
    null,
  );
  const [ticketStatus, setTicketStatus] = useState<TicketStatus>({
    kind: "idle",
    message: "Ready for a simulated order.",
  });
  const [portfolioRange, setPortfolioRange] = useState("7D");
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
  // The portfolio map renders only while its dialog is open (view not null).
  const mapDialogRef = useRef<HTMLDialogElement>(null);
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
  const [teamCashDrafts, setTeamCashDrafts] = useState<Record<string, string>>({});
  const [teamNameDrafts, setTeamNameDrafts] = useState<Record<string, string>>({});
  const [newTeamName, setNewTeamName] = useState("");
  const [teamEditor, setTeamEditor] = useState<{
    teamId: string;
    field: TeamEditorField;
  } | null>(null);
  const [teamActionBusy, setTeamActionBusy] = useState<string | null>(null);
  const [adminCashDraft, setAdminCashDraft] = useState<string | null>(null);
  const [adminCashBusy, setAdminCashBusy] = useState(false);
  const [adminCashFeedback, setAdminCashFeedback] = useState<TicketStatus | null>(
    null,
  );
  const [disqualifyArmed, setDisqualifyArmed] = useState<string | null>(null);
  const [removeTeamArmed, setRemoveTeamArmed] = useState<string | null>(null);
  const [hostFeedback, setHostFeedback] = useState("");
  const [resetArmed, setResetArmed] = useState(false);
  const [syncFlash, setSyncFlash] = useState(false);
  const [openRailSections, setOpenRailSections] = useState(INITIAL_RAIL_SECTIONS);
  const dashboardRequest = useRef<AbortController | null>(null);
  // Survives an ambiguous network failure so a manual retry of the same
  // ticket replays idempotently instead of double-filling.
  const pendingOrder = useRef<{ key: string; fingerprint: string } | null>(null);
  const autoLoginAttempted = useRef(false);
  const knownVersion = useRef(fallbackTeam.version);
  const lastMarketRefreshAttemptAt = useRef(0);

  const toggleRailSection = useCallback((section: RailSectionId) => {
    setOpenRailSections((current) => ({
      ...current,
      [section]: !current[section],
    }));
  }, []);

  const toggleTeamEditor = (teamId: string, field: TeamEditorField) => {
    setTeamEditor((current) =>
      current?.teamId === teamId && current.field === field
        ? null
        : { teamId, field },
    );
  };

  useEffect(() => {
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

          const login = await fetch("/api/auth/demo-login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: "alex" }),
          });
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
  }, [isManaged, router]);

  const fetchDashboard = useCallback(async (
    announce = false,
    refreshMarket = false,
  ) => {
    if (dashboardRequest.current && !announce) return;
    dashboardRequest.current?.abort();
    const controller = new AbortController();
    dashboardRequest.current = controller;
    if (refreshMarket) lastMarketRefreshAttemptAt.current = Date.now();
    const dashboardUrl = `/api/dashboard?refreshMarket=${refreshMarket ? "1" : "0"}`;

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

        const login = await fetch("/api/auth/demo-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: "alex" }),
        });
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

      const nextDashboard = payload as DashboardPayload;
      let refreshedSelectedQuote: Quote | null = null;
      if (refreshMarket) {
        try {
          const quoteResponse = await fetch(
            `/api/quotes?symbol=${encodeURIComponent(selectedSymbol)}`,
            { cache: "no-store", credentials: "same-origin", signal: controller.signal },
          );
          const quotePayload = (await readJson(quoteResponse)) as {
            results?: Quote[];
          };
          refreshedSelectedQuote =
            quotePayload.results?.find(
              (quote) => quote.symbol === selectedSymbol,
            ) ?? null;
        } catch {
          // The dashboard remains usable with its last disclosed market snapshot.
        }
      }
      if (controller.signal.aborted) return;
      const nextVersion = nextDashboard.team?.version ?? 0;
      const changed = nextVersion > knownVersion.current;
      knownVersion.current = nextVersion;
      setDashboard(nextDashboard);
      setSelectedQuote((current) => {
        const liveQuote = nextDashboard.availableSymbols.find(
          (quote) => quote.symbol === current.symbol,
        );
        return refreshedSelectedQuote?.symbol === current.symbol
          ? refreshedSelectedQuote
          : liveQuote ?? current;
      });
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
  }, [isManaged, router, selectedSymbol]);

  useEffect(() => {
    if (!sessionReady) return;
    const pollDashboard = () => {
      const refreshMarket =
        Date.now() - lastMarketRefreshAttemptAt.current >=
        MARKET_REFRESH_INTERVAL_MS;
      void fetchDashboard(false, refreshMarket);
    };
    const initial = window.setTimeout(pollDashboard, 0);
    const interval = window.setInterval(pollDashboard, TEAM_SYNC_INTERVAL_MS);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
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
            message: "Showing the last real market snapshot. Trading waits for a fresh quote.",
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
      const overview = payload as AdminOverview;
      setAdminOverview(overview);
      setTeamCashDrafts(cashDraftsForOverview(overview));
      setTeamNameDrafts(nameDraftsForOverview(overview));
      setTeamEditor((current) =>
        current && overview.teams.some((team) => team.id === current.teamId)
          ? current
          : null,
      );
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
  const rows = leaderboardRows(dashboard.leaderboard);
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
    Number.isInteger(wholeQuantity) && wholeQuantity > 0 && wholeQuantity <= 100_000;
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
  const reservedQuantity = Math.min(heldQuantity, holdingForQuote?.reservedQuantity ?? 0);
  const freeQuantity = heldQuantity - reservedQuantity;
  const workingOrdersEnabled = dashboard.workingOrdersEnabled;
  // Stop loss and take profit only sell; switching to Buy falls back to Market.
  const ticketOrderType: TicketOrderType = !workingOrdersEnabled
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
    side === "BUY" &&
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
                  : openWorkingOrderCount + newWorkingOrderCount > MAX_WAITING_ORDERS
                    ? `A ${isPlatformAdminRole(dashboard) ? "test account" : "team"} can have at most ${MAX_WAITING_ORDERS} waiting orders. Cancel one first.`
                    : null;
  const holdingsHaveLots = dashboard.holdings.some(
    (holding) => holding.assetClass === "CRYPTO",
  );
  const isPlatformAdmin = dashboard.currentUser.role === "platform_admin";
  const isCompetitionHost = dashboard.currentUser.role === "host";
  const canManageCompetition = isCompetitionHost || isPlatformAdmin;
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
  // Students can only trade while the listing's exchange is open; the server
  // enforces this too. The admin sandbox ignores market hours.
  const marketOpenForTrader = isPlatformAdmin || selectedQuote.marketOpen;
  const accountName = isPlatformAdmin ? "admin test account" : "team";
  // Why the order button is disabled, in plain words, or null when it isn't.
  // Shown live under the ticket so a greyed-out button always explains itself.
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
                        ? `This competition ended ${formatScheduleInstant(dashboard.competition.endsAt)}.`
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
                      : side === "BUY" && estimatedValue > portfolio.buyingPowerCents
                        ? `This order is larger than the ${accountName}'s available cash${
                            portfolio.reservedCashCents > 0
                              ? ` (${formatMoney(portfolio.reservedCashCents)} is set aside for waiting buys)`
                              : ""
                          }.`
                        : side === "SELL" && wholeQuantity > freeQuantity
                          ? heldQuantity === 0
                            ? `The ${accountName} doesn't hold any ${selectedQuote.symbol}.`
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
  // The most a single order can be: everything affordable when buying,
  // everything held when selling. Whole units only.
  const maxOrderQuantity =
    side === "BUY"
      ? ticketUnitCadCents > 0
        ? Math.min(
            100_000,
            Math.max(0, Math.floor(portfolio.buyingPowerCents / ticketUnitCadCents)),
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

  // Load the popular picks in the background as soon as the page opens, so
  // they are already there when someone clicks the search box.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/quotes?popular=1", {
          signal: controller.signal,
        });
        if (!response.ok) return;
        const payload = (await readJson(response)) as { sections?: PopularSection[] };
        const sections = payload.sections ?? [];
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
  }, []);

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
    if (!query || suggestionCache.current.has(query.toLowerCase())) return;
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
      const response = await fetch(`/api/quotes?q=${encodeURIComponent(query)}`, {
        cache: "no-store",
      });
      const payload = (await readJson(response)) as {
        results?: InstrumentSearchResult[];
      } & ApiErrorShape;
      if (!response.ok) {
        throw new Error(extractError(payload, "The symbol search failed."));
      }
      const results = payload.results ?? [];
      rememberSuggestions(query, results);
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
    if (manageSearching) setSearching(true);
    setTicketStatus({
      kind: "working",
      message: `Loading ${result.symbol} from the market feed…`,
    });
    try {
      const response = await fetch(
        `/api/quotes?symbol=${encodeURIComponent(result.symbol)}`,
        { cache: "no-store", credentials: "same-origin" },
      );
      const payload = (await readJson(response)) as { results?: Quote[] } & ApiErrorShape;
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
      setTicketStatus({
        kind: "error",
        message: error instanceof Error ? error.message : `Could not load ${result.symbol}.`,
      });
    } finally {
      if (manageSearching) setSearching(false);
    }
  };

  const selectQuote = (quote: Quote) => {
    setSelectedSymbol(quote.symbol);
    setSelectedQuote(quote);
    setSearchQuery("");
    setSearchResults([]);
    setSuggestionsOpen(false);
    setActiveSuggestion(-1);
    setQuoteHistory(null);
    // Prices typed for another listing mean nothing for this one (different
    // currency, scale, or lot size), so they start blank again.
    if (quote.symbol !== selectedQuote.symbol) {
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
        throw new Error(
          "The server could not be reached. Retry this ticket — the same order can't be placed twice.",
        );
      }
      const payload = await readJson(response);
      if (!response.ok) {
        if (response.status < 500 && response.status !== 408 && response.status !== 429) {
          pendingOrder.current = null;
        }
        throw new Error(extractError(payload, "The order could not be placed."));
      }
      const [entry] = (payload as { workingOrders?: WorkingOrderView[] }).workingOrders ?? [];
      if (!entry?.id) {
        throw new Error("The order response was incomplete. Retry this ticket with the same order key.");
      }
      pendingOrder.current = null;
      const amount = selectedIsCrypto
        ? `${number.format(entry.quantity)} ${unitWord("CRYPTO", entry.quantity)} of ${entry.symbol}`
        : `${number.format(entry.quantity)} ${entry.symbol}`;
      setTicketStatus({
        kind: "success",
        message: `${workingOrderName(entry.orderType, entry.side)} for ${amount} at ${formatWorkingOrderPrice(entry)} is waiting ${
          entry.timeInForce === "DAY" && entry.expiresAt
            ? `until ${formatScheduleInstant(entry.expiresAt)}`
            : "until it fills or is cancelled"
        }.${entry.reservedCashCents > 0 ? ` ${formatMoney(entry.reservedCashCents)} is set aside for it.` : ""}${
          bracket ? " Its exits start watching once it fills." : ""
        }`,
      });
      setTriggerPrice("");
      setTakeProfitPrice("");
      setStopLossPrice("");
      await fetchDashboard(true);
    } catch (error) {
      setTicketStatus({
        kind: "error",
        message:
          error instanceof Error
            ? `${error.message} Check the ticket and try again.`
            : "The order could not be placed. Check the ticket and try again.",
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

    setTicketStatus({
      kind: "working",
      message: isWaitingOrder
        ? `Placing the ${ORDER_TYPE_LABELS[ticketOrderType].toLowerCase()} order…`
        : `Recording ${side.toLowerCase()} order in the ${isPlatformAdmin ? "private admin" : "shared team"} ledger…`,
    });

    // Reuse the pending key only for a retry of the exact same ticket; any
    // edit to the ticket is a new order with a new key.
    const orderFingerprint = [
      dashboard.currentUser.id,
      selectedQuote.symbol,
      side,
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
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            side,
            symbol: selectedQuote.symbol,
            quantity: wholeQuantity,
            orderType: "MARKET",
            ...(bracket ? { bracket } : {}),
          }),
        });
      } catch {
        // No response arrived, so the order may or may not have committed.
        // The key is kept: pressing the button again replays safely.
        throw new Error(
          "The server could not be reached. Retry this ticket — the same order cannot fill twice.",
        );
      }

      const payload = await readJson(response);
      if (!response.ok) {
        // A gateway/server failure can arrive after the trade committed.
        // Keep the same key until a definitive result arrives.
        if (response.status < 500 && response.status !== 408 && response.status !== 429) {
          pendingOrder.current = null;
        }
        throw new Error(extractError(payload, "The order could not be recorded."));
      }
      const result = payload as OrderResult;
      if (!result.order?.id || !Number.isSafeInteger(result.portfolioVersion)) {
        throw new Error("The order response was incomplete. Retry this ticket with the same order key.");
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
        message:
          error instanceof Error
            ? `${error.message} Check the ticket and try again.`
            : "The order could not be recorded. Check the ticket and try again.",
      });
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
      await fetchAdminOverview();
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
      await fetchAdminOverview();
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

  const updateTeamStatus = async (teamId: string, status: TeamStatus) => {
    if (!canManageCompetition) return;
    if (status === "disqualified" && disqualifyArmed !== teamId) {
      setRemoveTeamArmed(null);
      setDisqualifyArmed(teamId);
      setHostFeedback(
        "Disqualification removes the team from active standings but remains reversible. Confirm to continue.",
      );
      return;
    }

    setTeamActionBusy(teamId);
    setHostFeedback(`Updating team status to ${status}…`);
    try {
      const response = await fetch(`/api/admin/teams/${encodeURIComponent(teamId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(extractError(payload, "The team status did not change."));
      }
      const overview = payload as AdminOverview;
      setAdminOverview(overview);
      setTeamCashDrafts(cashDraftsForOverview(overview));
      setTeamNameDrafts(nameDraftsForOverview(overview));
      setDisqualifyArmed(null);
      setHostFeedback(
        status === "active"
          ? "Team restored to active competition status."
          : status === "frozen"
            ? "Team frozen. Its portfolio is preserved and new trades are blocked."
            : "Team disqualified from active standings. You can restore it at any time.",
      );
      await fetchDashboard(true);
    } catch (error) {
      setHostFeedback(
        error instanceof Error ? error.message : "The team status did not change.",
      );
    } finally {
      setTeamActionBusy(null);
    }
  };

  const addCompetitionTeam = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canManageCompetition) return;

    const name = newTeamName.trim();
    if (!name) {
      setHostFeedback("Enter a team name before adding it.");
      return;
    }

    setTeamActionBusy("create");
    setHostFeedback(`Adding ${name}…`);
    try {
      const response = await fetch("/api/admin/teams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ name }),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(extractError(payload, "The team could not be added."));
      }

      const overview = payload as AdminOverview;
      setAdminOverview(overview);
      setTeamCashDrafts(cashDraftsForOverview(overview));
      setTeamNameDrafts(nameDraftsForOverview(overview));
      setNewTeamName("");
      setHostFeedback(
        `${name} was added with the competition's starting cash balance.`,
      );
      await fetchDashboard(true);
    } catch (error) {
      setHostFeedback(
        error instanceof Error ? error.message : "The team could not be added.",
      );
    } finally {
      setTeamActionBusy(null);
    }
  };

  const renameCompetitionTeam = async (
    event: FormEvent<HTMLFormElement>,
    teamId: string,
    currentName: string,
  ) => {
    event.preventDefault();
    if (!canManageCompetition) return;

    const name = (teamNameDrafts[teamId] ?? "").trim();
    if (!name) {
      setHostFeedback("Enter a team name before saving it.");
      return;
    }
    if (name === currentName) return;

    setTeamActionBusy(`rename:${teamId}`);
    setHostFeedback(`Renaming ${currentName}…`);
    try {
      const response = await fetch(`/api/admin/teams/${encodeURIComponent(teamId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ name }),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(extractError(payload, "The team could not be renamed."));
      }

      const overview = payload as AdminOverview;
      setAdminOverview(overview);
      setTeamCashDrafts(cashDraftsForOverview(overview));
      setTeamNameDrafts(nameDraftsForOverview(overview));
      setTeamEditor(null);
      setHostFeedback(`${currentName} is now ${name}.`);
      await fetchDashboard(true);
    } catch (error) {
      setHostFeedback(
        error instanceof Error ? error.message : "The team could not be renamed.",
      );
    } finally {
      setTeamActionBusy(null);
    }
  };

  const removeCompetitionTeam = async (
    teamId: string,
    teamName: string,
    memberCount: number,
  ) => {
    if (!canManageCompetition) return;
    if (removeTeamArmed !== teamId) {
      setDisqualifyArmed(null);
      setRemoveTeamArmed(teamId);
      const memberImpact =
        memberCount === 0
          ? "It has no assigned members."
          : memberCount === 1
            ? "Its 1 member will become unassigned."
            : `Its ${memberCount} members will become unassigned.`;
      setHostFeedback(
        `Removing ${teamName} permanently deletes its portfolio and trades. ${memberImpact} Confirm to continue.`,
      );
      return;
    }

    setTeamActionBusy(`remove:${teamId}`);
    setHostFeedback(`Removing ${teamName}…`);
    try {
      const response = await fetch(`/api/admin/teams/${encodeURIComponent(teamId)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(extractError(payload, "The team could not be removed."));
      }

      const overview = payload as AdminOverview;
      setAdminOverview(overview);
      setTeamCashDrafts(cashDraftsForOverview(overview));
      setTeamNameDrafts(nameDraftsForOverview(overview));
      setRemoveTeamArmed(null);
      setTeamEditor(null);
      setHostFeedback(
        memberCount === 0
          ? `${teamName} was removed.`
          : `${teamName} was removed. ${memberCount === 1 ? "Its member is" : `Its ${memberCount} members are`} now unassigned.`,
      );
      await fetchDashboard(true);
    } catch (error) {
      setHostFeedback(
        error instanceof Error ? error.message : "The team could not be removed.",
      );
    } finally {
      setTeamActionBusy(null);
    }
  };

  const updateTeamCash = async (
    event: FormEvent<HTMLFormElement>,
    teamId: string,
    teamName: string,
  ) => {
    event.preventDefault();
    if (!canManageCompetition) return;

    const cashCents = parseCashDraft(teamCashDrafts[teamId] ?? "");
    if (cashCents === null) {
      setHostFeedback(
        "Enter a non-negative CAD amount with no more than two decimal places.",
      );
      return;
    }

    setTeamActionBusy(`cash:${teamId}`);
    setHostFeedback(`Updating ${teamName}'s cash balance…`);
    try {
      const response = await fetch(
        `/api/admin/teams/${encodeURIComponent(teamId)}/cash`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cashCents }),
        },
      );
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(extractError(payload, "The cash balance did not change."));
      }

      const overview = payload as AdminOverview;
      setAdminOverview(overview);
      setTeamCashDrafts(cashDraftsForOverview(overview));
      setTeamNameDrafts(nameDraftsForOverview(overview));
      setTeamEditor(null);
      setHostFeedback(`${teamName}'s cash is now ${formatMoney(cashCents)}.`);
      await fetchDashboard(true);
    } catch (error) {
      setHostFeedback(
        error instanceof Error ? error.message : "The cash balance did not change.",
      );
    } finally {
      setTeamActionBusy(null);
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

      <div className="trading-room">
        <header className="app-header">
          <a className="brand-lockup" href="#top" aria-label="Luban Market Lab home">
            <span className="brand-lockup__luban">Luban</span>
            <span className="brand-lockup__product">Market Lab</span>
          </a>

          <div className="competition-lockup" id="top">
            <strong>{dashboard.competition.name}</strong>
            <span className={`state-tag state-tag--${dashboard.competition.phase}`}>
              <span className="state-dot" aria-hidden="true" />
              {dashboard.competition.phase}
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

        <section className="simulation-strip" aria-label="Prototype disclosure">
          <div>
            <FlaskIcon />
            <strong>Prototype mode</strong>
            <span>
              Simulated trading only. No real money or investment advice.
            </span>
          </div>
          <div>
            <span>Market data</span>
            <strong>
              {connection === "connected"
                ? `${marketSourceLabel(selectedQuote.source)}${selectedQuote.isStale ? " · STALE" : " · LATEST AVAILABLE"}`
                : "Connecting…"}
            </strong>
            <span className="market-info">
              <button
                className="market-info__trigger"
                type="button"
                aria-label="About the market data"
                aria-describedby="market-data-tooltip"
              >
                <InfoIcon />
              </button>
              <span
                className="market-info__bubble"
                id="market-data-tooltip"
                role="tooltip"
              >
                {selectedQuote.source === "YAHOO_FINANCE"
                  ? "Quotes and timestamped chart bars come from Yahoo Finance. Market responses are cached for at least 60 seconds to protect the free feed, may be delayed, and can be unavailable. All orders remain simulated."
                  : "This environment is using deterministic test market data. All prices and orders are simulated."}
              </span>
            </span>
          </div>
        </section>

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
                    ? "personal sandbox"
                    : "set cash to begin"
                  : dashboard.team?.status ??
                    (isCompetitionHost ? "view only" : "needs team")}
              </span>
            </div>

            <section className="portfolio-total" aria-label="Portfolio value">
              <span>Total portfolio value (CAD)</span>
              {/* Cash plus holdings: the same number the leaderboard ranks. */}
              <strong>{formatMoney(portfolio.totalValueCents)}</strong>
              <small>Price snapshot {formatTime(portfolio.asOf)}</small>
            </section>

            <dl className="metric-grid">
              <div>
                <dt>Cash (CAD)</dt>
                {isPlatformAdmin ? (
                  <dd className="admin-cash-editor">
                    <form
                      className="admin-cash-editor__form"
                      onSubmit={(event) => void updateAdminCash(event)}
                    >
                      <label htmlFor="admin-test-cash" className="sr-only">
                        Admin test cash (CAD)
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
                    </form>
                    <small
                      id="admin-test-cash-feedback"
                      className={`admin-cash-editor__feedback${
                        adminCashFeedback
                          ? ` admin-cash-editor__feedback--${adminCashFeedback.kind}`
                          : ""
                      }`}
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
                  </dd>
                ) : (
                  <dd>{formatMoney(portfolio.cashCents)}</dd>
                )}
              </div>
              <div>
                <dt>Buying power</dt>
                <dd>
                  {formatMoney(portfolio.buyingPowerCents)}
                  {portfolio.reservedCashCents > 0 ? (
                    <small>{formatMoney(portfolio.reservedCashCents)} set aside</small>
                  ) : null}
                </dd>
              </div>
              <div>
                <dt>Daily return</dt>
                <dd>
                  <ChangeValue cents={portfolio.dayChangeCents} percent={portfolio.dayChangePercent} />
                  <small>{formatPercent(portfolio.dayChangePercent)}</small>
                </dd>
              </div>
              <div>
                <dt>Total return</dt>
                <dd>
                  <ChangeValue cents={portfolio.totalReturnCents} percent={portfolio.totalReturnPercent} />
                  <small>{formatPercent(portfolio.totalReturnPercent)}</small>
                </dd>
              </div>
            </dl>

            <section className="portfolio-chart" aria-labelledby="portfolio-chart-title">
              <div className="chart-header">
                <h3 id="portfolio-chart-title">Portfolio value history</h3>
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

            <section className="holdings-section" aria-labelledby="holdings-heading">
              <div className="subheading-row">
                <h3 id="holdings-heading">Holdings</h3>
                <span>Ranked by market value</span>
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
                              {holding.reservedQuantity ? (
                                <small className="cell-note">
                                  {number.format(holding.reservedQuantity)} held for waiting sells
                                </small>
                              ) : null}
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

            {workingOrdersEnabled || dashboard.workingOrders.length > 0 ? (
              <section
                className="working-orders-section"
                aria-labelledby="working-orders-heading"
              >
                <div className="subheading-row">
                  <h3 id="working-orders-heading">Waiting orders</h3>
                  <span>
                    {openWorkingOrderCount} of {MAX_WAITING_ORDERS}
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
                                  {name} · {order.symbol}
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

            {isPlatformAdmin ? (
              <aside className="shared-callout shared-callout--private">
                <LockIcon />
                <div>
                  <strong>Private admin sandbox</strong>
                  <p>
                    Your cash, holdings, and orders are isolated from every team and
                    never affect the competition leaderboard.
                  </p>
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
                    onFocus={() => setSuggestionsOpen(true)}
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
              <div className="quote-symbol-block" aria-hidden="true">
                {selectedQuote.symbol.slice(0, 2)}
              </div>
              <div className="quote-identity">
                <div>
                  <h2 id="quote-heading">{selectedQuote.symbol}</h2>
                  {selectedAssetTag ? (
                    <em className="asset-tag">{selectedAssetTag}</em>
                  ) : null}
                  <span>{selectedQuote.name}</span>
                </div>
                {!quoteLoaded ? (
                  <span className="source-tag">Connecting to market data</span>
                ) : selectedQuote.sourceUrl ? (
                  <a
                    className="source-tag"
                    href={selectedQuote.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {marketSourceLabel(selectedQuote.source)}
                    {selectedQuote.isStale ? " · stale" : " · market data"}
                  </a>
                ) : (
                  <span className="source-tag">
                    {marketSourceLabel(selectedQuote.source)}
                  </span>
                )}
                <div className="quote-price">
                  <strong>{quoteLoaded ? formatMoney(selectedQuote.priceCadCents) : "—"}</strong>
                  <span>{selectedIsCrypto ? "CAD per lot" : "CAD"}</span>
                  {quoteLoaded ? <ChangeValue percent={selectedQuote.changePercent} /> : null}
                </div>
                {selectedIsCrypto ? (
                  <small className="quote-lot-note">
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
                  <small>
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
              </div>
            </section>

            <dl className="quote-facts">
              <div>
                <dt>Previous close</dt>
                <dd>
                  {quoteLoaded ? formatMoney(selectedQuote.previousCloseCadCents) : "—"}
                </dd>
              </div>
              <div>
                <dt>Day change</dt>
                <dd>
                  {quoteLoaded ? (
                    <ChangeValue
                      cents={
                        selectedQuote.priceCadCents - selectedQuote.previousCloseCadCents
                      }
                      percent={selectedQuote.changePercent}
                    />
                  ) : (
                    "—"
                  )}
                </dd>
              </div>
              <div>
                <dt>{selectedIsCrypto ? "Trading hours" : "Exchange"}</dt>
                <dd>{selectedIsCrypto ? "Crypto · 24/7" : selectedQuote.exchange}</dd>
              </div>
              <div>
                <dt>Sector</dt>
                <dd>{selectedQuote.sector}</dd>
              </div>
              <div>
                <dt>Quote time</dt>
                <dd>{quoteLoaded ? formatTime(selectedQuote.asOf) : "Loading…"}</dd>
              </div>
            </dl>

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
              <div className="ticket-topline">
                <fieldset className="side-control">
                  <legend className="sr-only">Order side</legend>
                  <button
                    type="button"
                    className={side === "BUY" ? "is-active" : ""}
                    aria-pressed={side === "BUY"}
                    onClick={() => {
                      setSide("BUY");
                      editTicket();
                      // Stop loss and take profit only sell.
                      if (orderType === "STOP_LOSS" || orderType === "TAKE_PROFIT") {
                        setOrderType("MARKET");
                      }
                    }}
                  >
                    Buy
                  </button>
                  <button
                    type="button"
                    className={side === "SELL" ? "is-active is-active--sell" : ""}
                    aria-pressed={side === "SELL"}
                    onClick={() => {
                      setSide("SELL");
                      editTicket();
                    }}
                  >
                    Sell
                  </button>
                </fieldset>
                {workingOrdersEnabled ? (
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
              </div>

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
                        ? `Ends ${selectedIsCrypto ? "at midnight ET" : "at 4:00 p.m. ET"} if not filled`
                        : "Waits until it fills or is cancelled"}
                    </small>
                  </div>
                </div>
              ) : null}

              {bracketAllowed ? (
                <div
                  className="ticket-bracket"
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
              ) : null}

              <div className="ticket-fields">
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
                      side === "BUY"
                        ? `Buy as many ${unitWord(selectedAssetClass, 2)} as the cash allows`
                        : `Sell every ${unitWord(selectedAssetClass, 1)} held`
                    }
                  >
                    {side === "BUY" ? "Max" : "All"}
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
                      {side === "BUY" ? "Buy the maximum?" : "Sell everything?"}
                    </h2>
                    <div id="max-confirm-body">
                      <p>
                        {side === "BUY" ? (
                          <>
                            This sets the quantity to{" "}
                            <strong>
                              {number.format(maxOrderQuantity)}{" "}
                              {unitWord(selectedAssetClass, maxOrderQuantity)} of{" "}
                              {selectedQuote.symbol}
                            </strong>
                            , about{" "}
                            <strong>{formatMoney(maxOrderQuantity * ticketUnitCadCents)}</strong>.
                            That uses nearly all of the{" "}
                            {formatMoney(portfolio.buyingPowerCents)} in buying power.
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
                <div>
                  <span>
                    {isWaitingOrder
                      ? selectedIsCrypto
                        ? "Current price per lot"
                        : "Current price"
                      : selectedIsCrypto
                        ? "Estimated fill per lot"
                        : "Estimated fill"}
                  </span>
                  <strong>
                    {quoteLoaded ? formatMoney(selectedQuote.priceCadCents) : "—"}
                  </strong>
                  <small>
                    {quoteLoaded
                      ? `${marketSourceLabel(selectedQuote.source)} snapshot`
                      : "Waiting for market data"}
                  </small>
                </div>
                <div>
                  <span>
                    {side === "BUY"
                      ? "Available cash"
                      : reservedQuantity > 0
                        ? "Free to sell"
                        : selectedIsCrypto
                          ? "Lots held"
                          : "Shares held"}
                  </span>
                  <strong>
                    {side === "BUY"
                      ? formatMoney(portfolio.buyingPowerCents)
                      : number.format(freeQuantity)}
                  </strong>
                  <small>
                    {side === "BUY"
                      ? portfolio.reservedCashCents > 0
                        ? `${formatMoney(portfolio.reservedCashCents)} set aside for waiting buys`
                        : isPlatformAdmin
                          ? "Admin test account"
                          : "Team account"
                      : reservedQuantity > 0
                        ? `${number.format(heldQuantity)} held · ${number.format(reservedQuantity)} held back for waiting sells`
                        : selectedIsCrypto
                          ? `${selectedQuote.symbol} · ${tokenAmountLabel(heldQuantity, selectedLotSize, selectedQuote.symbol)}`
                          : selectedQuote.symbol}
                  </small>
                </div>
                <div>
                  <span>
                    {setsAsideCash
                      ? "Cash set aside"
                      : isWaitingOrder
                        ? "Value at your price"
                        : "Estimated order value"}
                  </span>
                  <strong>
                    {quoteLoaded && (!isWaitingOrder || triggerPriceCents !== null)
                      ? formatMoney(estimatedValue)
                      : "—"}
                  </strong>
                  <small>
                    {setsAsideCash && selectedQuote.listingCurrency === "USD"
                      ? "Includes a 2% cushion for USD/CAD moves"
                      : "$0.00 simulated commission"}
                  </small>
                </div>
              </div>

              <div className="ticket-actions">
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
                      : `Place simulated ${side.toLowerCase()}`}
                  <ArrowIcon />
                </button>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => {
                    setQuantity("");
                    setTriggerPrice("");
                    setTakeProfitPrice("");
                    setStopLossPrice("");
                    setTicketStatus({ kind: "idle", message: "Order ticket cleared." });
                  }}
                >
                  Clear ticket
                </button>
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
                <table className="data-table leaderboard-table">
                  <thead>
                    <tr>
                      <th scope="col">Rank</th>
                      <th scope="col">Team</th>
                      <th scope="col">Value</th>
                      <th scope="col">Return</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 5).map((row) => (
                      <tr key={row.teamId} className={row.isCurrentTeam ? "is-current" : ""}>
                        <td data-label="Rank">{row.rank}</td>
                        <th scope="row" data-label="Team">
                          <span className="leaderboard-team">
                            <span>
                              {row.teamName}
                              {row.isCurrentTeam ? <small> Your team</small> : null}
                            </span>
                            {canManageCompetition ? (
                              <button
                                type="button"
                                className="leaderboard-map-button"
                                aria-haspopup="dialog"
                                aria-label={`Open ${row.teamName} portfolio map`}
                                onClick={() =>
                                  void openTeamPortfolioMap(row.teamId, row.teamName)
                                }
                              >
                                <TreemapIcon />
                                Map
                              </button>
                            ) : null}
                          </span>
                        </th>
                        <td data-label="Value">{formatMoney(row.totalValueCents)}</td>
                        <td data-label="Return">
                          <ChangeValue percent={row.returnPercent} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="snapshot-note">
                Every team is valued from the same cached market-data snapshot.
              </p>
            </AnimatedRailSection>

            <AnimatedRailSection
              className="host-section"
              headingId="host-heading"
              contentId="host-content"
              title="Host controls"
              icon={<LockIcon />}
              isOpen={openRailSections.host}
              onToggle={() => toggleRailSection("host")}
            >
              {canManageCompetition ? (
                <>
                  <div className="host-status">
                    <div>
                      <span>Competition</span>
                      <strong>{dashboard.competition.phase}</strong>
                    </div>
                    <div>
                      <span>Your access</span>
                      <strong>{isPlatformAdmin ? "Platform admin" : "Host"}</strong>
                    </div>
                  </div>
                  <p>
                    Manage competition state and team cash balances. Every action is
                    recorded.
                  </p>
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
                    Accounts &amp; invitations
                  </a>
                  <form
                    className="host-schedule"
                    aria-label="Competition schedule"
                    onSubmit={(event) => void saveCompetitionSchedule(event)}
                  >
                    <div className="host-schedule__heading">
                      <strong>Competition schedule</strong>
                      <span>
                        Trading is open between the start and end below. It
                        starts and stops automatically.
                      </span>
                    </div>
                    <label htmlFor="schedule-start">
                      <span>Start date &amp; time (ET)</span>
                      <input
                        id="schedule-start"
                        type="datetime-local"
                        value={
                          scheduleStartDraft ??
                          isoToZonedInputValue(dashboard.competition.startsAt)
                        }
                        onChange={(event) =>
                          setScheduleStartDraft(event.target.value)
                        }
                        disabled={hostBusy}
                      />
                    </label>
                    <label htmlFor="schedule-end">
                      <span>End date &amp; time (ET)</span>
                      <input
                        id="schedule-end"
                        type="datetime-local"
                        value={
                          scheduleEndDraft ??
                          isoToZonedInputValue(dashboard.competition.endsAt)
                        }
                        onChange={(event) =>
                          setScheduleEndDraft(event.target.value)
                        }
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
                        onChange={(event) =>
                          setScheduleCashDraft(event.target.value)
                        }
                        disabled={hostBusy || competitionHasTrades}
                      />
                    </label>
                    {competitionHasTrades ? (
                      <p className="host-schedule__note">
                        Starting cash is locked once trading has begun. Adjust
                        individual team balances below instead.
                      </p>
                    ) : null}
                    <button
                      className="button button--secondary"
                      type="submit"
                      disabled={hostBusy}
                    >
                      Save schedule
                    </button>
                  </form>
                  {dashboard.currentUser.role === "platform_admin" ? (
                    <a className="button button--secondary host-accounts-link" href="/admin/valuation-lab">
                      <FlaskIcon />
                      Past → Present valuation lab
                    </a>
                  ) : null}
                  <div className="host-teams" aria-label="Manage competition teams">
                    <div className="host-teams__heading">
                      <strong>Competition teams</strong>
                      <button
                        type="button"
                        onClick={() => void fetchAdminOverview()}
                        disabled={hostBusy || teamActionBusy !== null}
                      >
                        <RefreshIcon />
                        Refresh
                      </button>
                    </div>
                    <form
                      className="host-team__create"
                      onSubmit={(event) => void addCompetitionTeam(event)}
                    >
                      <label htmlFor="new-team-name">
                        <span>Add a team</span>
                        <input
                          id="new-team-name"
                          type="text"
                          maxLength={TEAM_NAME_MAX_LENGTH}
                          autoComplete="off"
                          value={newTeamName}
                          onChange={(event) => setNewTeamName(event.target.value)}
                          disabled={teamActionBusy !== null}
                          placeholder="Team name"
                        />
                      </label>
                      <button
                        type="submit"
                        disabled={teamActionBusy !== null || !newTeamName.trim()}
                      >
                        Add team
                      </button>
                    </form>
                    {adminOverview?.teams.length ? (
                      <ul>
                        {adminOverview.teams.map((team) => (
                          <li key={team.id}>
                            <div className="host-team__summary">
                              <div className="host-team__identity">
                                <div className="host-team__name-line">
                                  <strong>{team.name}</strong>
                                  <span className="host-team__quick-actions">
                                    <button
                                      className="host-team__edit-trigger"
                                      type="button"
                                      aria-label={`Rename ${team.name}`}
                                      aria-controls={`team-name-editor-${team.id}`}
                                      aria-expanded={
                                        teamEditor?.teamId === team.id &&
                                        teamEditor.field === "name"
                                      }
                                      data-active={
                                        teamEditor?.teamId === team.id &&
                                        teamEditor.field === "name"
                                      }
                                      title="Rename team"
                                      onClick={() => toggleTeamEditor(team.id, "name")}
                                      disabled={teamActionBusy !== null}
                                    >
                                      <PencilIcon />
                                    </button>
                                    <button
                                      className="host-team__edit-trigger"
                                      type="button"
                                      aria-label={`Set cash for ${team.name}`}
                                      aria-controls={`team-cash-editor-${team.id}`}
                                      aria-expanded={
                                        teamEditor?.teamId === team.id &&
                                        teamEditor.field === "cash"
                                      }
                                      data-active={
                                        teamEditor?.teamId === team.id &&
                                        teamEditor.field === "cash"
                                      }
                                      title="Set cash balance"
                                      onClick={() => toggleTeamEditor(team.id, "cash")}
                                      disabled={teamActionBusy !== null}
                                    >
                                      <CashIcon />
                                    </button>
                                  </span>
                                </div>
                                <small>{team.memberNames.join(", ") || "No members"}</small>
                              </div>
                              <span className={`team-state team-state--${team.status}`}>
                                {team.status}
                              </span>
                            </div>
                            {teamEditor?.teamId === team.id &&
                            teamEditor.field === "name" ? (
                              <form
                                id={`team-name-editor-${team.id}`}
                                className="host-team__name"
                                onSubmit={(event) =>
                                  void renameCompetitionTeam(event, team.id, team.name)
                                }
                              >
                                <label htmlFor={`team-name-${team.id}`}>
                                  <span>Team name</span>
                                  <input
                                    id={`team-name-${team.id}`}
                                    type="text"
                                    maxLength={TEAM_NAME_MAX_LENGTH}
                                    autoComplete="off"
                                    value={teamNameDrafts[team.id] ?? team.name}
                                    onChange={(event) =>
                                      setTeamNameDrafts((current) => ({
                                        ...current,
                                        [team.id]: event.target.value,
                                      }))
                                    }
                                    disabled={teamActionBusy !== null}
                                  />
                                </label>
                                <button
                                  type="submit"
                                  disabled={
                                    teamActionBusy !== null ||
                                    !teamNameDrafts[team.id]?.trim() ||
                                    teamNameDrafts[team.id]?.trim() === team.name
                                  }
                                >
                                  Rename
                                </button>
                              </form>
                            ) : null}
                            {teamEditor?.teamId === team.id &&
                            teamEditor.field === "cash" ? (
                              <form
                                id={`team-cash-editor-${team.id}`}
                                className="host-team__cash"
                                onSubmit={(event) =>
                                  void updateTeamCash(event, team.id, team.name)
                                }
                              >
                                <label htmlFor={`team-cash-${team.id}`}>
                                  <span>Cash balance (CAD)</span>
                                  <input
                                    id={`team-cash-${team.id}`}
                                    aria-label={`Cash for ${team.name}`}
                                    type="number"
                                    min="0"
                                    max="1000000000000"
                                    step="0.01"
                                    inputMode="decimal"
                                    value={
                                      teamCashDrafts[team.id] ??
                                      (team.cashCents / 100).toFixed(2)
                                    }
                                    onChange={(event) =>
                                      setTeamCashDrafts((current) => ({
                                        ...current,
                                        [team.id]: event.target.value,
                                      }))
                                    }
                                    disabled={teamActionBusy !== null}
                                  />
                                </label>
                                <button
                                  type="submit"
                                  disabled={
                                    teamActionBusy !== null ||
                                    parseCashDraft(teamCashDrafts[team.id] ?? "") ===
                                      null ||
                                    parseCashDraft(teamCashDrafts[team.id] ?? "") ===
                                      team.cashCents
                                  }
                                >
                                  Set cash
                                </button>
                              </form>
                            ) : null}
                            <div className="host-team__actions">
                              {team.status === "active" ? (
                                <button
                                  type="button"
                                  onClick={() => void updateTeamStatus(team.id, "frozen")}
                                  disabled={teamActionBusy !== null}
                                >
                                  Freeze
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => void updateTeamStatus(team.id, "active")}
                                  disabled={teamActionBusy !== null}
                                >
                                  Restore
                                </button>
                              )}
                              {team.status !== "disqualified" ? (
                                <button
                                  type="button"
                                  className={disqualifyArmed === team.id ? "is-danger" : ""}
                                  onClick={() => void updateTeamStatus(team.id, "disqualified")}
                                  disabled={teamActionBusy !== null}
                                >
                                  {disqualifyArmed === team.id
                                    ? "Confirm disqualify"
                                    : "Disqualify"}
                                </button>
                              ) : null}
                              {disqualifyArmed === team.id ? (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setDisqualifyArmed(null);
                                    setHostFeedback("Disqualification cancelled.");
                                  }}
                                  disabled={teamActionBusy !== null}
                                >
                                  Cancel
                                </button>
                              ) : null}
                              <button
                                type="button"
                                className={removeTeamArmed === team.id ? "is-danger" : ""}
                                onClick={() =>
                                  void removeCompetitionTeam(
                                    team.id,
                                    team.name,
                                    team.memberNames.length,
                                  )
                                }
                                disabled={teamActionBusy !== null}
                              >
                                {removeTeamArmed === team.id
                                  ? "Confirm remove"
                                  : "Remove team"}
                              </button>
                              {removeTeamArmed === team.id ? (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setRemoveTeamArmed(null);
                                    setHostFeedback("Team removal cancelled.");
                                  }}
                                  disabled={teamActionBusy !== null}
                                >
                                  Cancel
                                </button>
                              ) : null}
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : adminOverview ? (
                      <p className="host-teams__empty">
                        No competition teams yet. Add the first team above.
                      </p>
                    ) : (
                      <p>Loading team controls…</p>
                    )}
                    <div className="host-feedback" role="status" aria-live="polite">
                      {teamActionBusy === "create"
                        ? "Adding team…"
                        : teamActionBusy?.startsWith("rename:")
                          ? "Saving team name…"
                          : teamActionBusy?.startsWith("remove:")
                            ? "Removing team…"
                            : teamActionBusy?.startsWith("cash:")
                              ? "Saving cash balance…"
                              : teamActionBusy
                                ? "Saving team status…"
                                : hostFeedback}
                    </div>
                  </div>
                </>
              ) : (
                <div className="host-locked">
                  {isManaged ? (
                    <p>
                      Host controls are reserved for the competition host. Ask
                      your host if something about your team needs attention.
                    </p>
                  ) : (
                    <>
                      <p>Switch to the host identity to pause trading or manage teams.</p>
                      <button
                        className="button button--secondary"
                        type="button"
                        onClick={() => void switchIdentity("host")}
                        disabled={identityBusy}
                      >
                        <UserIcon />
                        Open host view
                      </button>
                    </>
                  )}
                </div>
              )}
            </AnimatedRailSection>
          </aside>
        </div>

        <footer className="status-footer">
          <div>
            <PulseIcon />
            <strong>Local ledger</strong>
            <span className={`connection-state connection-state--${connection}`}>
              {connection === "connected" ? "Connected" : connection}
            </span>
            <span
              className="status-cadence"
              data-team-sync-ms={TEAM_SYNC_INTERVAL_MS}
              data-market-refresh-ms={MARKET_REFRESH_INTERVAL_MS}
            >
              <span>Team ledger every 60 seconds</span>
              <span>Market prices every 60 seconds</span>
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
              Version <strong>v{APP_VERSION}</strong>
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
