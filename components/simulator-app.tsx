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
  useMemo,
  useRef,
  useState,
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
  Leaderboard,
  LeaderboardRow,
  PortfolioPoint,
  PortfolioSummary,
  Quote,
  QuoteHistory,
  QuoteRange,
  SessionUser,
  TeamSummary,
  TeamStatus,
  TradeSide,
} from "@/lib/contracts";
import {
  MARKET_REFRESH_INTERVAL_MS,
  TEAM_SYNC_INTERVAL_MS,
} from "@/lib/market-config";
import {
  ArrowIcon,
  ChevronDownIcon,
  FlaskIcon,
  InfoIcon,
  LockIcon,
  PauseIcon,
  PlayIcon,
  PulseIcon,
  RefreshIcon,
  SearchIcon,
  UserIcon,
  UsersIcon,
} from "./simulator-icons";

type DashboardPayload = Omit<Dashboard, "leaderboard"> & {
  leaderboard: LeaderboardRow[] | Leaderboard;
  session: {
    user: SessionUser;
    demoUsers: DemoUser[];
  };
};

type RailSectionId = "presence" | "activity" | "leaderboard" | "host";

const INITIAL_RAIL_SECTIONS: Record<RailSectionId, boolean> = {
  presence: true,
  activity: true,
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
  | { kind: "error"; message: string };

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
  asOf: FIXED_NOW,
};

const currency = new Intl.NumberFormat("en-CA", {
  style: "currency",
  currency: "CAD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const number = new Intl.NumberFormat("en-CA");

function formatMoney(cents: number): string {
  return currency.format(cents / 100);
}

function cashDraftsForOverview(overview: AdminOverview): Record<string, string> {
  return Object.fromEntries(
    overview.teams.map((team) => [team.id, (team.cashCents / 100).toFixed(2)]),
  );
}

function formatScheduleInstant(iso: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  return date.toLocaleString("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function isoToLocalInputValue(iso: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
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

function chartGeometry(
  points: ChartPoint[],
  width: number,
  height: number,
  compressGaps = false,
) {
  const values = points.map((point) => point.valueCents);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = Math.max(max - min, 1);
  const top = 14;
  const bottom = height - 24;
  const left = 8;
  const right = width - 8;
  const times = points.map((point) => Date.parse(point.at));
  const validTimes = times.every((time) => Number.isFinite(time));
  const firstTime = times[0];
  const timeSpread = validTimes ? Math.max(times.at(-1)! - firstTime, 1) : 1;

  const coordinates = points.map((point, index) => ({
    x:
      left +
      (validTimes && !compressGaps
        ? (times[index] - firstTime) / timeSpread
        : index / Math.max(points.length - 1, 1)) *
        (right - left),
    y: bottom - ((point.valueCents - min) / spread) * (bottom - top),
  }));

  return {
    min,
    max,
    coordinates,
    path: coordinates
      .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
      .join(" "),
  };
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
}) {
  const width = compact ? 440 : 640;
  const height = compact ? 156 : 250;
  const svgRef = useRef<SVGSVGElement>(null);
  const [activeAt, setActiveAt] = useState<string | null>(null);
  const [interactionMethod, setInteractionMethod] = useState<
    "keyboard" | "mouse" | "touch" | null
  >(null);

  if (loading || points.length < 2) {
    return (
      <div
        className={`chart chart--empty ${compact ? "chart--compact" : ""}`}
        aria-busy={loading}
        role="status"
      >
        <span>{loading ? "Loading real market history…" : emptyMessage}</span>
      </div>
    );
  }

  const geometry = chartGeometry(points, width, height, compressGaps);
  const positive = points.at(-1)!.valueCents >= points[0].valueCents;
  const formatValue = (value: number) => formatNativeMoney(value, currency);
  const firstLabel = formatChartTime(points[0].at, range, timeZone);
  const lastLabel = formatChartTime(points.at(-1)!.at, range, timeZone);
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

  const selectPoint = (index: number, method: "keyboard" | "mouse" | "touch") => {
    const boundedIndex = Math.max(0, Math.min(points.length - 1, index));
    setActiveAt(points[boundedIndex].at);
    setInteractionMethod(method);
  };

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
    } else if (event.key === "Escape") {
      event.preventDefault();
      setActiveAt(null);
      setInteractionMethod(null);
    }
  };

  return (
    <div
      className={`chart ${compact ? "chart--compact" : ""} ${interactive ? "chart--interactive" : ""}`}
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
            : `${label}. Low ${formatValue(geometry.min)}, high ${formatValue(
                geometry.max,
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
        {[0.15, 0.4, 0.65, 0.9].map((position) => (
          <line
            key={position}
            x1="8"
            x2={width - 8}
            y1={position * height}
            y2={position * height}
            className="chart__grid"
          />
        ))}
        <path
          d={geometry.path}
          className={`chart__line ${positive ? "chart__line--positive" : "chart__line--negative"}`}
          vectorEffect="non-scaling-stroke"
        />
        <circle
          cx={geometry.coordinates.at(-1)?.x}
          cy={geometry.coordinates.at(-1)?.y}
          r="4"
          className="chart__last-point"
          vectorEffect="non-scaling-stroke"
        />
        {activeCoordinate ? (
          <>
            <line
              x1={activeCoordinate.x}
              x2={activeCoordinate.x}
              y1="14"
              y2={height - 24}
              className="chart__crosshair"
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
            x="8"
            y="14"
            width={width - 16}
            height={height - 38}
            className="chart__interaction-surface"
          />
        ) : null}
      </svg>
      {activePoint && activeCoordinate ? (
        <div
          className={`chart__tooltip ${
            activeCoordinate.x < width * 0.32
              ? "chart__tooltip--after"
              : activeCoordinate.x > width * 0.68
                ? "chart__tooltip--before"
                : "chart__tooltip--center"
          }`}
          style={{ left: `${(activeCoordinate.x / width) * 100}%` }}
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
      <div className="chart__value-axis" aria-hidden="true">
        <span>{formatValue(geometry.max)}</span>
        <span>{formatValue(geometry.min)}</span>
      </div>
      <div className="chart__axis" aria-hidden="true">
        <span>{firstLabel}</span>
        <span>{lastLabel}</span>
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
  const [side, setSide] = useState<TradeSide>("BUY");
  const [quantity, setQuantity] = useState("10");
  const [ticketStatus, setTicketStatus] = useState<TicketStatus>({
    kind: "idle",
    message: "Ready for a simulated order.",
  });
  const [portfolioRange, setPortfolioRange] = useState("1W");
  const [quoteRange, setQuoteRange] = useState<QuoteRange>("1D");
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
  const [teamActionBusy, setTeamActionBusy] = useState<string | null>(null);
  const [adminCashDraft, setAdminCashDraft] = useState<string | null>(null);
  const [adminCashBusy, setAdminCashBusy] = useState(false);
  const [adminCashFeedback, setAdminCashFeedback] = useState<TicketStatus | null>(
    null,
  );
  const [disqualifyArmed, setDisqualifyArmed] = useState<string | null>(null);
  const [hostFeedback, setHostFeedback] = useState("");
  const [resetArmed, setResetArmed] = useState(false);
  const [syncFlash, setSyncFlash] = useState(false);
  const [openRailSections, setOpenRailSections] = useState(INITIAL_RAIL_SECTIONS);
  const pollInFlight = useRef(false);
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
    if (pollInFlight.current) return;
    pollInFlight.current = true;
    if (refreshMarket) lastMarketRefreshAttemptAt.current = Date.now();
    const dashboardUrl = `/api/dashboard?refreshMarket=${refreshMarket ? "1" : "0"}`;

    try {
      let response = await fetch(dashboardUrl, {
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
            { cache: "no-store", credentials: "same-origin" },
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
      const nextVersion = nextDashboard.team?.version ?? 0;
      const changed = nextVersion > knownVersion.current;
      knownVersion.current = nextVersion;
      setDashboard(nextDashboard);
      setSelectedQuote((current) => {
        const liveQuote = nextDashboard.availableSymbols.find(
          (quote) => quote.symbol === current.symbol,
        );
        return refreshedSelectedQuote ?? liveQuote ?? current;
      });
      setConnection("connected");
      setConnectionError("");

      if (changed || announce) {
        setSyncFlash(true);
        window.setTimeout(() => setSyncFlash(false), 900);
      }
    } catch (error) {
      setConnection((current) =>
        current === "connecting" ? "connecting" : "reconnecting",
      );
      setConnectionError(
        error instanceof Error ? error.message : "Could not reach the local server.",
      );
    } finally {
      pollInFlight.current = false;
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
        const response = await fetch(
          `/api/quotes/history?symbol=${encodeURIComponent(selectedSymbol)}&range=${quoteRange}`,
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
  }, [connection, historyRefreshKey, quoteRange, selectedSymbol, sessionReady]);

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
  const wholeQuantity = Number(quantity);
  const quantityIsValid =
    Number.isInteger(wholeQuantity) && wholeQuantity > 0 && wholeQuantity <= 100_000;
  const estimatedValue = quantityIsValid
    ? selectedQuote.priceCadCents * wholeQuantity
    : 0;
  const holdingForQuote = dashboard.holdings.find(
    (holding) => holding.symbol === selectedQuote.symbol,
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
  const canTrade =
    connection === "connected" &&
    !selectedQuote.isStale &&
    tradingAccountIsOpen &&
    quantityIsValid &&
    (side === "BUY"
      ? estimatedValue <= portfolio.buyingPowerCents
      : wholeQuantity <= (holdingForQuote?.quantity ?? 0));
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
  const quoteLoaded =
    connection === "connected" &&
    !(selectedQuote.source === "LUBAN_SIMULATED" && selectedQuote.isStale);

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
      setSearchResults(results);
      const normalizedQuery = query
        .toUpperCase()
        .replace(/^([A-Z0-9]+)\.([A-Z])\.TO$/, "$1-$2.TO")
        .replace(/^([A-Z0-9]+)\.([A-Z])$/, "$1-$2");
      const exact = results.find((result) => result.symbol === normalizedQuery);
      if (exact) {
        await loadSearchResult(exact, false);
      } else if (results.length === 0) {
        setTicketStatus({
          kind: "error",
          message: `No NYSE, Nasdaq, or TSX stock matched “${query}”.`,
        });
      } else {
        setTicketStatus({
          kind: "idle",
          message: `Found ${results.length} supported ${results.length === 1 ? "stock" : "stocks"}. Choose a listing to load its market price.`,
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
    result: InstrumentSearchResult,
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
    setQuoteHistory(null);
    setTicketStatus({
      kind: "idle",
      message: `${quote.symbol} loaded from ${marketSourceLabel(quote.source)}.`,
    });
  };

  const placeOrder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canTrade) {
      const reason = connection !== "connected"
        ? "Wait for the simulator to reconnect before trading."
        : selectedQuote.isStale
          ? "Trading waits for a fresh market quote."
          : !quantityIsValid
            ? "Enter a positive whole number of shares."
            : isPlatformAdmin && !hasAdminTradingAccount
              ? "Set your admin test cash before placing an order."
              : isCompetitionHost
                ? "Host accounts are view-only and cannot place orders."
                : side === "BUY" && estimatedValue > portfolio.buyingPowerCents
                  ? `This order is larger than the ${isPlatformAdmin ? "admin test account’s" : "team’s"} available cash.`
                  : side === "SELL" &&
                      wholeQuantity > (holdingForQuote?.quantity ?? 0)
                    ? `The ${isPlatformAdmin ? "admin test account" : "team"} holds only ${holdingForQuote?.quantity ?? 0} shares of ${selectedQuote.symbol}.`
                    : dashboard.competition.phase === "scheduled"
                      ? `Trading opens ${formatScheduleInstant(dashboard.competition.startsAt)}.`
                      : dashboard.competition.phase === "ended"
                        ? `This competition ended ${formatScheduleInstant(dashboard.competition.endsAt)}.`
                        : "Trading is unavailable while the competition or team is paused.";
      setTicketStatus({ kind: "error", message: reason });
      return;
    }

    setTicketStatus({
      kind: "working",
      message: `Recording ${side.toLowerCase()} order in the ${isPlatformAdmin ? "private admin" : "shared team"} ledger…`,
    });

    // Reuse the pending key only for a retry of the exact same ticket; any
    // edit to symbol, side, or quantity is a new order with a new key.
    const orderFingerprint = `${selectedQuote.symbol}|${side}|${wholeQuantity}`;
    const idempotencyKey =
      pendingOrder.current?.fingerprint === orderFingerprint
        ? pendingOrder.current.key
        : createIdempotencyKey();
    pendingOrder.current = { key: idempotencyKey, fingerprint: orderFingerprint };

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
          }),
        });
      } catch {
        // No response arrived, so the order may or may not have committed.
        // The key is kept: pressing the button again replays safely.
        throw new Error(
          "The server could not be reached. Retry this ticket — the same order cannot fill twice.",
        );
      }

      // A response, success or rejection, is a definitive outcome; the next
      // attempt is a genuinely new order.
      pendingOrder.current = null;

      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(extractError(payload, "The order could not be recorded."));
      }
      const result = payload as OrderResult;
      setTicketStatus({
        kind: "success",
        message: `${result.order.side} ${result.order.quantity} ${
          result.order.symbol
        } filled once at ${formatMoney(
          result.order.fillPriceCadCents,
        )}. Portfolio v${result.portfolioVersion}.`,
      });
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

    if (scheduleStartDraft !== null && scheduleStartDraft !== "") {
      body.startsAt = new Date(scheduleStartDraft).toISOString();
    }
    if (scheduleEndDraft !== null && scheduleEndDraft !== "") {
      body.endsAt = new Date(scheduleEndDraft).toISOString();
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
    : dashboard.team?.memberNames.map((name, index) => {
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
      }) ?? [
        {
          id: "host",
          name: dashboard.currentUser.name,
          role: "Competition host",
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
          </div>

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
                <span className="version-tag">
                  v{teamVersion} {isPlatformAdmin ? "private" : "shared"}
                </span>
              }
            />

            <div className="team-line">
              <span>{isPlatformAdmin ? "Account" : "Team"}</span>
              <strong>
                {isPlatformAdmin
                  ? "Personal test account"
                  : dashboard.team?.name ?? "Host overview"}
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
                  : dashboard.team?.status ?? "view only"}
              </span>
            </div>

            <section className="portfolio-total" aria-label="Portfolio value">
              <span>Total portfolio value (CAD)</span>
              <strong>
                {formatMoney(
                  isPlatformAdmin
                    ? portfolio.totalValueCents
                    : portfolio.holdingsValueCents,
                )}
              </strong>
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
                <dd>{formatMoney(portfolio.buyingPowerCents)}</dd>
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
                  {["1W", "1M", "ALL"].map((range) => (
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
                points={dashboard.portfolioHistory}
                label={`${portfolioRange} portfolio value chart`}
                compact
              />
            </section>

            <section className="holdings-section" aria-labelledby="holdings-heading">
              <div className="subheading-row">
                <h3 id="holdings-heading">Holdings</h3>
                <span>Ranked by market value</span>
              </div>
              {dashboard.holdings.length > 0 ? (
                <div className="table-scroll">
                  <table className="data-table holdings-table">
                    <thead>
                      <tr>
                        <th scope="col">Symbol</th>
                        <th scope="col">Shares</th>
                        <th scope="col">Price</th>
                        <th scope="col">Market value</th>
                        <th scope="col">Gain/loss</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...dashboard.holdings]
                        .sort((a, b) => b.marketValueCents - a.marketValueCents)
                        .map((holding) => (
                          <tr key={holding.symbol}>
                            <th scope="row" data-label="Symbol">
                              <button
                                type="button"
                                className="symbol-button"
                                onClick={() => {
                                  const quote = dashboard.availableSymbols.find(
                                    (candidate) => candidate.symbol === holding.symbol,
                                  );
                                  if (quote) selectQuote(quote);
                                }}
                              >
                                <strong>{holding.symbol}</strong>
                                <span>{holding.name}</span>
                              </button>
                            </th>
                            <td data-label="Shares">{number.format(holding.quantity)}</td>
                            <td data-label="Price">{formatMoney(holding.currentPriceCadCents)}</td>
                            <td data-label="Market value">{formatMoney(holding.marketValueCents)}</td>
                            <td data-label="Gain/loss">
                              <ChangeValue
                                cents={holding.gainLossCents}
                                percent={holding.gainLossPercent}
                              />
                            </td>
                          </tr>
                        ))}
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
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="NYSE / NASDAQ / TSX"
                    autoComplete="off"
                  />
                  <button type="submit" aria-label="Search symbols" disabled={searching}>
                    <SearchIcon />
                  </button>
                </form>
              }
            />

            {searchResults.length > 0 ? (
              <div
                className="search-results"
                role="region"
                aria-label="Symbol results"
                aria-busy={searching}
              >
                {searchResults.slice(0, 10).map((result) => (
                  <button
                    key={result.symbol}
                    type="button"
                    disabled={searching}
                    onClick={() => void loadSearchResult(result)}
                  >
                    <strong>{result.symbol}</strong>
                    <span>{result.name}</span>
                    <span>{result.exchange}</span>
                  </button>
                ))}
              </div>
            ) : null}

            <section className="quote-summary" aria-labelledby="quote-heading">
              <div className="quote-symbol-block" aria-hidden="true">
                {selectedQuote.symbol.slice(0, 2)}
              </div>
              <div className="quote-identity">
                <div>
                  <h2 id="quote-heading">{selectedQuote.symbol}</h2>
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
                  <span>CAD</span>
                  {quoteLoaded ? <ChangeValue percent={selectedQuote.changePercent} /> : null}
                </div>
                {quoteLoaded && selectedQuote.listingCurrency === "USD" ? (
                  <small>
                    Native quote {formatNativeMoney(selectedQuote.priceCents, "USD")} ·
                    FX {(selectedQuote.fxRateBasisPoints / 10000).toFixed(4)}
                  </small>
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
                <dt>Exchange</dt>
                <dd>{selectedQuote.exchange}</dd>
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
                      aria-pressed={quoteRange === range}
                      onClick={() => setQuoteRange(range)}
                    >
                      {range}
                    </button>
                  ))}
                </div>
                <span className="chart-kind">
                  Raw close · trading gaps compressed · {selectedQuote.listingCurrency}
                </span>
              </div>
              <LineChart
                points={quotePoints}
                label={`${quoteRange} ${selectedQuote.symbol} price`}
                currency={selectedQuote.listingCurrency}
                range={quoteRange}
                timeZone={quoteHistory?.exchangeTimeZone}
                loading={historyLoading}
                emptyMessage={historyError || "Not enough market bars are available yet."}
                interactive
                compressGaps
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

            <form className="order-ticket" id="order-ticket" onSubmit={placeOrder}>
              <div className="ticket-topline">
                <fieldset className="side-control">
                  <legend className="sr-only">Order side</legend>
                  <button
                    type="button"
                    className={side === "BUY" ? "is-active" : ""}
                    aria-pressed={side === "BUY"}
                    onClick={() => setSide("BUY")}
                  >
                    Buy
                  </button>
                  <button
                    type="button"
                    className={side === "SELL" ? "is-active is-active--sell" : ""}
                    aria-pressed={side === "SELL"}
                    onClick={() => setSide("SELL")}
                  >
                    Sell
                  </button>
                </fieldset>
                <div className="order-type">
                  <span>Order type</span>
                  <strong>Market</strong>
                </div>
              </div>

              <div className="ticket-fields">
                <label>
                  <span>Quantity</span>
                  <input
                    inputMode="numeric"
                    min="1"
                    max="100000"
                    step="1"
                    type="number"
                    value={quantity}
                    onChange={(event) => setQuantity(event.target.value)}
                    aria-describedby="quantity-help"
                  />
                  <small id="quantity-help">Whole shares only</small>
                </label>
                <div>
                  <span>Estimated fill</span>
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
                  <span>{side === "BUY" ? "Available cash" : "Shares held"}</span>
                  <strong>
                    {side === "BUY"
                      ? formatMoney(portfolio.buyingPowerCents)
                      : number.format(holdingForQuote?.quantity ?? 0)}
                  </strong>
                  <small>
                    {side === "BUY"
                      ? isPlatformAdmin
                        ? "Admin test account"
                        : "Team account"
                      : selectedQuote.symbol}
                  </small>
                </div>
                <div>
                  <span>Estimated order value</span>
                  <strong>{quoteLoaded ? formatMoney(estimatedValue) : "—"}</strong>
                  <small>$0.00 simulated commission</small>
                </div>
              </div>

              <div className="ticket-actions">
                <button
                  className={`button button--primary ${side === "SELL" ? "button--sell" : ""}`}
                  type="submit"
                  disabled={!canTrade || ticketStatus.kind === "working"}
                >
                  {ticketStatus.kind === "working"
                    ? "Recording order…"
                    : `Place simulated ${side.toLowerCase()}`}
                  <ArrowIcon />
                </button>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => {
                    setQuantity("");
                    setTicketStatus({ kind: "idle", message: "Order ticket cleared." });
                  }}
                >
                  Clear ticket
                </button>
              </div>

              <div
                className={`ticket-message ticket-message--${ticketStatus.kind}`}
                role="status"
                aria-live="polite"
              >
                <InfoIcon />
                <span>{ticketStatus.message}</span>
              </div>

              <aside className="order-disclosure">
                Orders are simulated and fill once at the server’s latest available market
                snapshot. No brokerage order is sent. Past performance does not predict
                future results.
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
              className="activity-section sync-region"
              headingId="activity-heading"
              contentId="activity-content"
              title={
                isPlatformAdmin
                  ? "Test account activity"
                  : isCompetitionHost
                    ? "Competition activity"
                    : "Team activity"
              }
              aside={<span>Immutable log</span>}
              isOpen={openRailSections.activity}
              onToggle={() => toggleRailSection("activity")}
              data-flash={syncFlash}
            >
              <ol className="activity-list">
                {dashboard.recentActivity.slice(0, 5).map((item) => (
                  <li key={item.id}>
                    <time dateTime={item.createdAt}>{formatActivityTime(item.createdAt)}</time>
                    <div>
                      <strong>{item.title}</strong>
                      <p>{item.detail}</p>
                    </div>
                    <span className={`activity-state activity-state--${item.type.toLowerCase()}`}>
                      {item.type === "ORDER_FILLED" ? "Filled" : "Logged"}
                    </span>
                  </li>
                ))}
              </ol>
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
                          {row.teamName}
                          {row.isCurrentTeam ? <small> Your team</small> : null}
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
                      <span>Start date &amp; time</span>
                      <input
                        id="schedule-start"
                        type="datetime-local"
                        value={
                          scheduleStartDraft ??
                          isoToLocalInputValue(dashboard.competition.startsAt)
                        }
                        onChange={(event) =>
                          setScheduleStartDraft(event.target.value)
                        }
                        disabled={hostBusy}
                      />
                    </label>
                    <label htmlFor="schedule-end">
                      <span>End date &amp; time</span>
                      <input
                        id="schedule-end"
                        type="datetime-local"
                        value={
                          scheduleEndDraft ??
                          isoToLocalInputValue(dashboard.competition.endsAt)
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
                    {adminOverview ? (
                      <ul>
                        {adminOverview.teams.map((team) => (
                          <li key={team.id}>
                            <div className="host-team__summary">
                              <span>
                                <strong>{team.name}</strong>
                                <small>{team.memberNames.join(", ") || "No members"}</small>
                              </span>
                              <span className={`team-state team-state--${team.status}`}>
                                {team.status}
                              </span>
                            </div>
                            <form
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
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>Loading team controls…</p>
                    )}
                    <div className="host-feedback" role="status" aria-live="polite">
                      {teamActionBusy?.startsWith("cash:")
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
        </footer>

        <div className="sr-only" role="status" aria-live="polite">
          {syncFlash ? `Shared portfolio updated to version ${teamVersion}.` : ""}
        </div>
      </div>
    </main>
  );
}
