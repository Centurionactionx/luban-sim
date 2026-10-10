import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  SESSION_COOKIE_NAME,
  canHostCompetitions,
  getSessionFromToken,
  listAdminLog,
  listAdminLogOptions,
  type AdminLogCategory,
  type AdminLogFilters,
  type AdminLogOptions,
  type AdminLogRow,
  type AdminLogSide,
  type AdminLogStatus,
} from "@/lib";
import { isManagedAuthMode } from "@/lib/server/auth-mode";
import { DISPLAY_TIME_ZONE, zonedInputValueToIso } from "@/lib/time";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Global admin log · Luban Market Lab",
};

const PAGE_LIMIT = 200;
const MAX_CURSOR_LENGTH = 500;

type RawParams = Record<string, string | string[] | undefined>;

const CATEGORY_OPTIONS: ReadonlyArray<{ value: AdminLogCategory; label: string; tag: string }> = [
  { value: "TRADE", label: "Trades", tag: "Trade" },
  { value: "WORKING_ORDER", label: "Working orders", tag: "Working" },
  { value: "HOST", label: "Host changes", tag: "Host" },
  { value: "ACCOUNT", label: "Accounts & names", tag: "Account" },
  { value: "SECURITY", label: "Security", tag: "Security" },
];

const STATUS_OPTIONS: ReadonlyArray<{ value: AdminLogStatus; label: string }> = [
  { value: "FILLED", label: "Filled" },
  { value: "REJECTED", label: "Rejected" },
  { value: "PLACED", label: "Placed" },
  { value: "CANCELLED", label: "Cancelled" },
  { value: "EXPIRED", label: "Expired" },
];

const SIDE_OPTIONS: ReadonlyArray<{ value: AdminLogSide; label: string }> = [
  { value: "BUY", label: "Buy" },
  { value: "SELL", label: "Sell" },
  { value: "SHORT", label: "Short" },
  { value: "COVER", label: "Cover" },
];

const ROLE_LABELS: Record<string, string> = {
  platform_admin: "platform admin",
  host: "host",
  student: "student",
};

const cadFormat = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" });
const quantityFormat = new Intl.NumberFormat("en-CA", { maximumFractionDigits: 8 });
const timeFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_TIME_ZONE,
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const fullTimeFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: DISPLAY_TIME_ZONE,
  dateStyle: "full",
  timeStyle: "long",
});

/** Signed-in host or platform admin, or a redirect away (same guard as the accounts page). */
async function requireHostOrAdminId(): Promise<string> {
  if (isManagedAuthMode()) {
    const {
      getManagedSessionState,
      hasManagedMfaEnrolled,
      isAdminMfaRequired,
    } = await import("@/lib/server/managed-identity");

    const state = await getManagedSessionState();

    if (state.kind === "signed-out") {
      redirect("/sign-in");
    }

    if (state.kind !== "linked" || !canHostCompetitions(state.user.role)) {
      redirect("/");
    }

    if (isAdminMfaRequired() && !(await hasManagedMfaEnrolled(state.subject))) {
      redirect("/account?mfa=required");
    }

    return state.user.id;
  }

  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const user = token ? await getSessionFromToken(token) : null;

  if (!user || !canHostCompetitions(user.role)) {
    redirect("/");
  }

  return user.id;
}

function valuesOf(raw: RawParams, key: string): string[] {
  const value = raw[key];
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).filter((item) => item.length > 0);
}

function firstOf(raw: RawParams, key: string): string {
  return valuesOf(raw, key)[0] ?? "";
}

/** Keeps only the values the enum allows, in the enum's order. */
function pick<T extends string>(values: string[], options: ReadonlyArray<{ value: T }>): T[] {
  return options.map((option) => option.value).filter((value) => values.includes(value));
}

/** A YYYY-MM-DD date that exists, or "". */
function parseDay(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  const [year, month, day] = match.slice(1).map(Number);
  const real = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
  return real === value ? value : "";
}

/** First instant of an ET calendar day. */
function dayStartIso(day: string): string | null {
  return zonedInputValueToIso(`${day}T00:00`);
}

/** Last instant of an ET calendar day (inclusive): one millisecond before the next day starts. */
function dayEndIso(day: string): string | null {
  const [year, month, date] = day.split("-").map(Number);
  const nextDay = new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
  const nextStart = dayStartIso(nextDay);
  return nextStart ? new Date(new Date(nextStart).getTime() - 1).toISOString() : null;
}

function formatTime(iso: string): string {
  return timeFormat.format(new Date(iso)).replace(", ", " ");
}

function formatFullTime(iso: string): string {
  return fullTimeFormat.format(new Date(iso));
}

function formatCents(cents: number | null): string {
  return cents === null ? "" : cadFormat.format(cents / 100);
}

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role.replace(/_/g, " ");
}

function AdminLogLine({ row }: { row: AdminLogRow }) {
  const category = CATEGORY_OPTIONS.find((option) => option.value === row.category);
  return (
    <tr className={row.status === "REJECTED" ? "admin-log__row admin-log__row--rejected" : "admin-log__row"}>
      <td>
        <time dateTime={row.createdAt} title={formatFullTime(row.createdAt)}>
          {formatTime(row.createdAt)}
        </time>
      </td>
      <td>
        <span className={`admin-log-tag admin-log-tag--${row.category.toLowerCase()}`}>
          {category?.tag ?? row.category}
        </span>
      </td>
      <td>{row.event}</td>
      <td>
        {row.teamName}
        {row.sandbox ? <span className="admin-log-sandbox">sandbox</span> : null}
      </td>
      <td>{row.actorName}</td>
      <td>{row.subjectName}</td>
      <td>{row.symbol}</td>
      <td>
        {row.side ? (
          <span className={`admin-log-side admin-log-side--${row.side.toLowerCase()}`}>
            {SIDE_OPTIONS.find((option) => option.value === row.side)?.label}
          </span>
        ) : null}
      </td>
      <td className="admin-log__num">
        {row.quantity === null ? "" : quantityFormat.format(row.quantity)}
      </td>
      <td className="admin-log__num">{formatCents(row.priceCadCents)}</td>
      <td className="admin-log__num">{formatCents(row.valueCadCents)}</td>
      <td className="admin-log__num">{formatCents(row.cashAfterCadCents)}</td>
      <td className="admin-log__detail" title={row.detail}>
        <span>{row.detail}</span>
      </td>
    </tr>
  );
}

export default async function AdminLogPage({
  searchParams,
}: {
  searchParams: Promise<RawParams>;
}) {
  const actorId = await requireHostOrAdminId();
  const raw = await searchParams;
  const options: AdminLogOptions = await listAdminLogOptions(actorId);

  const categories = pick(valuesOf(raw, "category"), CATEGORY_OPTIONS);
  const statuses = pick(valuesOf(raw, "status"), STATUS_OPTIONS);
  const sides = pick(valuesOf(raw, "side"), SIDE_OPTIONS);

  const teamParam = firstOf(raw, "team");
  const teamIds = new Set(options.teams.map((team) => team.id));
  const teamId = teamParam === "sandbox" || teamIds.has(teamParam) ? teamParam : "";

  const userParam = firstOf(raw, "user");
  const userId = options.users.some((user) => user.id === userParam) ? userParam : "";

  const symbol = firstOf(raw, "symbol").trim().toUpperCase();
  const symbolValid = /^[A-Z0-9.\-_/^=]{1,24}$/.test(symbol) ? symbol : "";

  const from = parseDay(firstOf(raw, "from"));
  const to = parseDay(firstOf(raw, "to"));
  const includeSandbox = firstOf(raw, "sandbox") === "1";
  const before = firstOf(raw, "before");
  const cursor = before.length > 0 && before.length <= MAX_CURSOR_LENGTH ? before : "";

  const filters: AdminLogFilters = { limit: PAGE_LIMIT };
  if (categories.length) filters.categories = categories;
  if (statuses.length) filters.statuses = statuses;
  if (sides.length) filters.sides = sides;
  if (teamId) filters.teamId = teamId;
  if (userId) filters.userId = userId;
  if (symbolValid) filters.symbol = symbolValid;
  const fromIso = from ? dayStartIso(from) : null;
  if (fromIso) filters.from = fromIso;
  const toIso = to ? dayEndIso(to) : null;
  if (toIso) filters.to = toIso;
  if (includeSandbox) filters.includeSandbox = true;
  if (cursor) filters.before = cursor;

  const page = await listAdminLog(actorId, filters);

  const teamName = options.teams.find((team) => team.id === teamId)?.name;
  const summary: string[] = [];
  if (categories.length) {
    summary.push(
      categories
        .map((value) => CATEGORY_OPTIONS.find((option) => option.value === value)?.label ?? value)
        .join(", "),
    );
  }
  if (statuses.length) {
    summary.push(
      statuses
        .map((value) => STATUS_OPTIONS.find((option) => option.value === value)?.label ?? value)
        .join(", "),
    );
  }
  if (sides.length) {
    summary.push(
      sides
        .map((value) => SIDE_OPTIONS.find((option) => option.value === value)?.label ?? value)
        .join(", "),
    );
  }
  if (teamId) {
    summary.push(teamId === "sandbox" ? "admin sandboxes" : `team ${teamName ?? teamId}`);
  }
  if (userId) {
    summary.push(`person ${options.users.find((user) => user.id === userId)?.name ?? userId}`);
  }
  if (symbolValid) summary.push(`symbol ${symbolValid}`);
  if (from) summary.push(`from ${from}`);
  if (to) summary.push(`to ${to}`);
  if (includeSandbox && teamId !== "sandbox") summary.push("admin sandbox trades included");

  const rows = page.rows;
  const hasFilters = summary.length > 0;

  // Keeps every filter (repeated keys included) and swaps in the cursor for the next page.
  const olderSearch = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (key === "before") continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) olderSearch.append(key, item);
    }
  }

  if (page.nextCursor) olderSearch.set("before", page.nextCursor);
  const olderHref = `/admin/log?${olderSearch.toString()}`;

  return (
    <main className="accounts-page">
      <div className="accounts-sheet admin-log-sheet">
        <header className="accounts-header">
          <div>
            <p className="route-state__brand">Luban Market Lab</p>
            <h1>Global admin log</h1>
          </div>
          <Link className="button button--secondary" href="/">
            Back to the Market Lab
          </Link>
        </header>

        <section className="admin-log" aria-label="Global admin log">
          <form className="admin-log-filters" method="get" action="/admin/log">
            <fieldset>
              <legend>Category</legend>
              {CATEGORY_OPTIONS.map((option) => (
                <label key={option.value} className="admin-log-check">
                  <input
                    type="checkbox"
                    name="category"
                    value={option.value}
                    defaultChecked={categories.includes(option.value)}
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>Status</legend>
              {STATUS_OPTIONS.map((option) => (
                <label key={option.value} className="admin-log-check">
                  <input
                    type="checkbox"
                    name="status"
                    value={option.value}
                    defaultChecked={statuses.includes(option.value)}
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>Side</legend>
              {SIDE_OPTIONS.map((option) => (
                <label key={option.value} className="admin-log-check">
                  <input
                    type="checkbox"
                    name="side"
                    value={option.value}
                    defaultChecked={sides.includes(option.value)}
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>
            <label className="admin-log-field">
              <span>Team</span>
              <select name="team" defaultValue={teamId}>
                <option value="">All teams</option>
                {options.teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.sandbox ? `${team.name} (sandbox)` : team.name}
                  </option>
                ))}
                <option value="sandbox">Admin sandboxes</option>
              </select>
            </label>
            <label className="admin-log-field">
              <span>Person</span>
              <select name="user" defaultValue={userId}>
                <option value="">Anyone</option>
                {options.users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {`${user.name} (${roleLabel(user.role)})`}
                  </option>
                ))}
              </select>
            </label>
            <label className="admin-log-field">
              <span>Symbol</span>
              <input type="text" name="symbol" defaultValue={symbolValid} maxLength={24} size={8} />
            </label>
            <label className="admin-log-field">
              <span>From (ET)</span>
              <input type="date" name="from" defaultValue={from} />
            </label>
            <label className="admin-log-field">
              <span>To (ET)</span>
              <input type="date" name="to" defaultValue={to} />
            </label>
            <label className="admin-log-check">
              <input type="checkbox" name="sandbox" value="1" defaultChecked={includeSandbox} />
              Include admin sandbox trades
            </label>
            <div className="admin-log-filters__actions">
              <button type="submit" className="button button--secondary">
                Apply
              </button>
              <Link href="/admin/log">Clear</Link>
            </div>
          </form>

          <p className="admin-log-count">
            <strong>{`Showing ${rows.length} ${rows.length === 1 ? "row" : "rows"}`}</strong>{" "}
            <span>(newest first)</span>
            {hasFilters ? <span> · Filtered by {summary.join(" · ")}</span> : null}
          </p>

          {rows.length === 0 ? (
            <p className="admin-log-empty">
              {hasFilters ? "No events match these filters." : "No events yet."}
            </p>
          ) : (
            <div className="admin-log__scroll">
              <table className="admin-log__table">
                <thead>
                  <tr>
                    <th>Time (ET)</th>
                    <th>Category</th>
                    <th>Event</th>
                    <th>Team</th>
                    <th>Actor</th>
                    <th>Subject</th>
                    <th>Symbol</th>
                    <th>Side</th>
                    <th className="admin-log__num">Qty</th>
                    <th className="admin-log__num">Price</th>
                    <th className="admin-log__num">Value</th>
                    <th className="admin-log__num">Cash after</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <AdminLogLine key={row.id} row={row} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {page.nextCursor ? (
            <p className="admin-log-more">
              <Link href={olderHref}>
                Load older →
              </Link>
            </p>
          ) : null}
        </section>
      </div>
    </main>
  );
}
