import type {
  AdminLogCategory,
  AdminLogFilters,
  AdminLogOptions,
  AdminLogPage,
  AdminLogRow,
  AdminLogSide,
  AdminLogStatus,
} from "../contracts";
import { requireHost } from "./admin";
import { getDb } from "./db";
import { getCompetitionSummary } from "./queries";

type Param = string | number;
type Numeric = number | string;

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const ALL_CATEGORIES: AdminLogCategory[] = ["TRADE", "WORKING_ORDER", "HOST", "ACCOUNT", "SECURITY"];
const WORKING_ORDER_STATUSES: AdminLogStatus[] = ["PLACED", "CANCELLED", "EXPIRED"];
const SECURITY_TYPES = [
  "ACCESS_DENIED",
  "ACCOUNT_ROLE_CHANGED",
  "ADMIN_BOOTSTRAPPED",
  "ACCOUNT_RELINKED",
  "ACCOUNT_SUSPENDED",
  "ACCOUNT_RESTORED",
];
const AUDIT_LABELS: Record<string, string> = {
  INVITATION_CREATED: "Invitation created",
  INVITATION_REVOKED: "Invitation revoked",
  INVITATION_ACCEPTED: "Invitation accepted",
  ACCOUNT_CREATED: "Account created",
  ACCOUNT_CLAIMED: "Account claimed",
  ACCOUNT_RENAMED: "Renamed",
  ACCOUNT_TEAM_CHANGED: "Team changed",
  ACCOUNT_DELETED: "Account deleted",
  ACCOUNT_SUSPENDED: "Suspended",
  ACCOUNT_RESTORED: "Restored",
  ACCOUNT_ROLE_CHANGED: "Role changed",
  ACCOUNT_RELINKED: "Relinked",
  ADMIN_BOOTSTRAPPED: "Admin bootstrapped",
  ACCESS_DENIED: "Access denied",
};

// Fills: a sell that leaves the holding short opens a short; a buy that
// starts from a short position covers it. Mirrors the SQL below.
const ORDER_SIDE_SQL: Record<AdminLogSide, string> = {
  BUY: "(o.side = 'BUY' AND o.holding_quantity_after - o.quantity >= 0)",
  COVER: "(o.side = 'BUY' AND o.holding_quantity_after - o.quantity < 0)",
  SELL: "(o.side = 'SELL' AND o.holding_quantity_after >= 0)",
  SHORT: "(o.side = 'SELL' AND o.holding_quantity_after < 0)",
};

const ACTIVITY_CATEGORY_SQL: Record<"WORKING_ORDER" | "HOST" | "ACCOUNT", string> = {
  WORKING_ORDER: "a.type LIKE 'WORKING_ORDER_%'",
  ACCOUNT: "a.type = 'MEMBER_JOINED'",
  HOST: "(a.type NOT LIKE 'WORKING_ORDER_%' AND a.type <> 'MEMBER_JOINED')",
};

interface Cursor {
  createdAt: string;
  /** Source-prefixed row id, as AdminLogRow.id. */
  id: string;
}

interface Scope {
  categories?: AdminLogCategory[];
  statuses?: AdminLogStatus[];
  sides?: AdminLogSide[];
  symbol?: string;
  teamId?: string;
  includeSandbox: boolean;
  userId?: string;
  from?: string;
  to?: string;
  cursor: Cursor | null;
  /** Rows to fetch per source: one more than the page, to detect a next page. */
  fetch: number;
}

/** Builds a WHERE clause and keeps its parameters in the same order. */
class Where {
  private readonly clauses: string[] = [];
  private readonly params: Param[] = [];

  add(clause: string, ...params: Param[]): this {
    this.clauses.push(clause);
    this.params.push(...params);
    return this;
  }

  sql(): string {
    return this.clauses.length ? `WHERE ${this.clauses.join(" AND ")}` : "";
  }

  values(extra: Param): Param[] {
    return [...this.params, extra];
  }
}

interface OrderRow {
  id: string;
  created_at: string;
  side: string;
  quantity: Numeric;
  symbol: string;
  fill_price_cad_cents: Numeric;
  gross_cents: Numeric;
  cash_after_cents: Numeric;
  holding_quantity_after: Numeric;
  team_id: string;
  team_name: string | null;
  sandbox_owner: string | null;
  actor_name: string | null;
}

interface RejectionRow {
  id: string;
  created_at: string;
  side: string | null;
  quantity: Numeric | null;
  symbol: string | null;
  message: string;
  team_id: string | null;
  team_name: string | null;
  sandbox_owner: string | null;
  actor_name: string | null;
}

interface ActivityRow {
  id: string;
  created_at: string;
  type: string;
  title: string;
  detail: string;
  team_id: string | null;
  team_name: string | null;
  sandbox_owner: string | null;
  actor_name: string | null;
}

interface AuditRow {
  id: string;
  created_at: string;
  type: string;
  detail: string;
  actor_name: string | null;
  subject_name: string | null;
}

function toNumber(value: Numeric | null): number | null {
  return value === null ? null : Number(value);
}

function nonEmpty<T>(list: T[] | undefined): T[] | undefined {
  return list?.length ? list : undefined;
}

function parseCursor(value: string | undefined): Cursor | null {
  const match = /^([^|]+)\|([^|]+)$/.exec(value ?? "");
  if (!match || !Number.isFinite(Date.parse(match[1]))) return null;
  return { createdAt: match[1], id: match[2] };
}

function applyTime(where: Where, scope: Scope, created: string, id: string): void {
  if (scope.from) where.add(`${created} >= ?`, scope.from);
  if (scope.to) where.add(`${created} <= ?`, scope.to);
  if (scope.cursor) {
    const { createdAt, id: cursorId } = scope.cursor;
    where.add(`(${created} < ? OR (${created} = ? AND ${id} < ?))`, createdAt, createdAt, cursorId);
  }
}

function applyTeam(where: Where, scope: Scope, teamColumn: string): void {
  if (scope.teamId === "sandbox") {
    where.add("t.sandbox_owner_user_id IS NOT NULL");
    return;
  }
  // Picking one team shows it even when it is a sandbox.
  if (scope.teamId) {
    where.add(`${teamColumn} = ?`, scope.teamId);
    return;
  }
  // Rows without a team (LEFT JOIN miss) count as real, so they stay.
  if (!scope.includeSandbox) where.add("t.sandbox_owner_user_id IS NULL");
}

async function fillRows(scope: Scope): Promise<AdminLogRow[]> {
  const where = new Where().add("o.status = 'FILLED'");
  if (scope.sides) {
    where.add(`(${scope.sides.map((side) => ORDER_SIDE_SQL[side]).join(" OR ")})`);
  }
  if (scope.symbol) where.add("UPPER(o.symbol) = ?", scope.symbol);
  if (scope.userId) where.add("o.actor_user_id = ?", scope.userId);
  applyTeam(where, scope, "o.team_id");
  applyTime(where, scope, "o.created_at", "('order:' || o.id)");

  const db = await getDb();
  const rows = await db.all<OrderRow>(
    `
      SELECT
        o.id, o.created_at, o.side, o.quantity, o.symbol,
        o.fill_price_cad_cents, o.gross_cents, o.cash_after_cents,
        o.holding_quantity_after, o.team_id,
        t.name AS team_name, t.sandbox_owner_user_id AS sandbox_owner,
        u.name AS actor_name
      FROM orders o
      JOIN teams t ON t.id = o.team_id
      LEFT JOIN users u ON u.id = o.actor_user_id
      ${where.sql()}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT ?
    `,
    where.values(scope.fetch),
  );

  return rows.map((row): AdminLogRow => {
    const holdingAfter = Number(row.holding_quantity_after);
    const quantity = Number(row.quantity);
    const side: AdminLogSide =
      row.side === "SELL"
        ? holdingAfter < 0 ? "SHORT" : "SELL"
        : holdingAfter - quantity < 0 ? "COVER" : "BUY";

    return {
      id: `order:${row.id}`,
      createdAt: row.created_at,
      category: "TRADE",
      event: "Filled",
      status: "FILLED",
      teamId: row.team_id,
      teamName: row.team_name,
      sandbox: row.sandbox_owner !== null,
      actorName: row.actor_name,
      subjectName: null,
      symbol: row.symbol,
      side,
      quantity,
      priceCadCents: toNumber(row.fill_price_cad_cents),
      valueCadCents: toNumber(row.gross_cents),
      cashAfterCadCents: toNumber(row.cash_after_cents),
      detail: "",
    };
  });
}

async function rejectionRows(scope: Scope, sides: AdminLogSide[] | undefined): Promise<AdminLogRow[]> {
  // A rejection stores the requested side as BUY or SELL; it has no fill to infer SHORT or COVER from.
  const where = new Where();
  if (sides) where.add(`r.side IN (${sides.map(() => "?").join(", ")})`, ...sides);
  if (scope.symbol) where.add("UPPER(r.symbol) = ?", scope.symbol);
  if (scope.userId) where.add("r.actor_user_id = ?", scope.userId);
  applyTeam(where, scope, "r.team_id");
  applyTime(where, scope, "r.created_at", "('reject:' || r.id)");

  const db = await getDb();
  const rows = await db.all<RejectionRow>(
    `
      SELECT
        r.id, r.created_at, r.side, r.quantity, r.symbol, r.message, r.team_id,
        t.name AS team_name, t.sandbox_owner_user_id AS sandbox_owner,
        u.name AS actor_name
      FROM order_rejections r
      LEFT JOIN teams t ON t.id = r.team_id
      LEFT JOIN users u ON u.id = r.actor_user_id
      ${where.sql()}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ?
    `,
    where.values(scope.fetch),
  );

  return rows.map((row): AdminLogRow => ({
    id: `reject:${row.id}`,
    createdAt: row.created_at,
    category: "TRADE",
    event: "Rejected",
    status: "REJECTED",
    teamId: row.team_id,
    teamName: row.team_name,
    sandbox: row.sandbox_owner !== null,
    actorName: row.actor_name,
    subjectName: null,
    symbol: row.symbol,
    side: row.side === "BUY" || row.side === "SELL" ? row.side : null,
    quantity: toNumber(row.quantity),
    priceCadCents: null,
    valueCadCents: null,
    cashAfterCadCents: null,
    detail: row.message,
  }));
}

async function activityRows(
  scope: Scope,
  categories: Array<keyof typeof ACTIVITY_CATEGORY_SQL>,
  statuses: AdminLogStatus[] | undefined,
): Promise<AdminLogRow[]> {
  const where = new Where().add("a.type <> 'ORDER_FILLED'");
  where.add(`(${categories.map((category) => ACTIVITY_CATEGORY_SQL[category]).join(" OR ")})`);
  if (statuses) {
    where.add(
      `a.type IN (${statuses.map(() => "?").join(", ")})`,
      ...statuses.map((status) => `WORKING_ORDER_${status}`),
    );
  }
  if (scope.userId) where.add("a.actor_user_id = ?", scope.userId);
  applyTeam(where, scope, "a.team_id");
  applyTime(where, scope, "a.created_at", "('activity:' || a.id)");

  const db = await getDb();
  const rows = await db.all<ActivityRow>(
    `
      SELECT
        a.id, a.created_at, a.type, a.title, a.detail, a.team_id,
        t.name AS team_name, t.sandbox_owner_user_id AS sandbox_owner,
        u.name AS actor_name
      FROM activity_events a
      LEFT JOIN teams t ON t.id = a.team_id
      LEFT JOIN users u ON u.id = a.actor_user_id
      ${where.sql()}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ?
    `,
    where.values(scope.fetch),
  );

  return rows.map((row): AdminLogRow => {
    const workingOrder = row.type.startsWith("WORKING_ORDER_");
    return {
      id: `activity:${row.id}`,
      createdAt: row.created_at,
      category: workingOrder ? "WORKING_ORDER" : row.type === "MEMBER_JOINED" ? "ACCOUNT" : "HOST",
      event: row.title,
      status: workingOrder ? (row.type.slice("WORKING_ORDER_".length) as AdminLogStatus) : null,
      teamId: row.team_id,
      teamName: row.team_name,
      sandbox: row.sandbox_owner !== null,
      actorName: row.actor_name,
      subjectName: null,
      symbol: null,
      side: null,
      quantity: null,
      priceCadCents: null,
      valueCadCents: null,
      cashAfterCadCents: null,
      detail: row.detail,
    };
  });
}

async function auditRows(scope: Scope, categories: Array<"SECURITY" | "ACCOUNT">): Promise<AdminLogRow[]> {
  const where = new Where();
  if (categories.length === 1) {
    const inList = SECURITY_TYPES.map(() => "?").join(", ");
    if (categories[0] === "SECURITY") {
      where.add(`e.type IN (${inList})`, ...SECURITY_TYPES);
    } else {
      where.add(`e.type NOT IN (${inList})`, ...SECURITY_TYPES);
    }
  }
  if (scope.userId) where.add("(e.actor_user_id = ? OR e.subject_user_id = ?)", scope.userId, scope.userId);
  applyTime(where, scope, "e.created_at", "('audit:' || e.id)");

  const db = await getDb();
  const rows = await db.all<AuditRow>(
    `
      SELECT
        e.id, e.created_at, e.type, e.detail,
        actor.name AS actor_name, subject.name AS subject_name
      FROM auth_audit_events e
      LEFT JOIN users actor ON actor.id = e.actor_user_id
      LEFT JOIN users subject ON subject.id = e.subject_user_id
      ${where.sql()}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT ?
    `,
    where.values(scope.fetch),
  );

  return rows.map((row): AdminLogRow => ({
    id: `audit:${row.id}`,
    createdAt: row.created_at,
    category: SECURITY_TYPES.includes(row.type) ? "SECURITY" : "ACCOUNT",
    event: AUDIT_LABELS[row.type] ?? row.type,
    status: null,
    teamId: null,
    teamName: null,
    sandbox: false,
    actorName: row.actor_name,
    subjectName: row.subject_name,
    symbol: null,
    side: null,
    quantity: null,
    priceCadCents: null,
    valueCadCents: null,
    cashAfterCadCents: null,
    detail: row.detail,
  }));
}

/** Newest first; ties broken by the prefixed id, matching the SQL cursor. */
function newestFirst(a: AdminLogRow, b: AdminLogRow): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

/**
 * The global admin log: fills, rejections, working-order events, host changes,
 * and account events merged into one newest-first feed. Read-only.
 */
export async function listAdminLog(
  actorUserId: string,
  filters: AdminLogFilters = {},
): Promise<AdminLogPage> {
  await requireHost(actorUserId);

  const limit = Number.isFinite(filters.limit)
    ? Math.min(Math.max(Math.trunc(filters.limit as number), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const scope: Scope = {
    categories: nonEmpty(filters.categories),
    statuses: nonEmpty(filters.statuses),
    sides: nonEmpty(filters.sides),
    symbol: filters.symbol?.trim().toUpperCase() || undefined,
    teamId: filters.teamId || undefined,
    includeSandbox: filters.includeSandbox === true,
    userId: filters.userId || undefined,
    from: filters.from || undefined,
    to: filters.to || undefined,
    cursor: parseCursor(filters.before),
    fetch: limit + 1,
  };
  const { categories, statuses, sides } = scope;
  const wants = <T>(list: T[] | undefined, value: T) => !list || list.includes(value);

  const pending: Array<Promise<AdminLogRow[]>> = [];

  if (wants(categories, "TRADE")) {
    if (wants(statuses, "FILLED")) pending.push(fillRows(scope));
    const rejectionSides = sides?.filter((side) => side === "BUY" || side === "SELL");
    if (wants(statuses, "REJECTED") && (!rejectionSides || rejectionSides.length)) {
      pending.push(rejectionRows(scope, rejectionSides));
    }
  }

  // Activity has no side, price, or symbol, so those filters rule it out.
  const activityCategories = (categories ?? ALL_CATEGORIES).filter(
    (category): category is "WORKING_ORDER" | "HOST" | "ACCOUNT" =>
      category === "WORKING_ORDER" || category === "HOST" || category === "ACCOUNT",
  );
  const activityStatuses = statuses?.filter((status) => WORKING_ORDER_STATUSES.includes(status));
  if (!sides && !scope.symbol && activityCategories.length && (!statuses || activityStatuses?.length)) {
    pending.push(activityRows(scope, activityCategories, activityStatuses));
  }

  // Audit events have no team, so a team filter rules them out.
  const auditCategories = (categories ?? ["SECURITY", "ACCOUNT"]).filter(
    (category): category is "SECURITY" | "ACCOUNT" => category === "SECURITY" || category === "ACCOUNT",
  );
  if (!scope.teamId && !sides && !scope.symbol && !statuses && auditCategories.length) {
    pending.push(auditRows(scope, auditCategories));
  }

  const merged = (await Promise.all(pending)).flat().sort(newestFirst);
  const rows = merged.slice(0, limit);
  const last = rows.at(-1);

  return {
    rows,
    nextCursor: merged.length > limit && last ? `${last.createdAt}|${last.id}` : null,
  };
}

/** Teams of the current competition and every non-deleted account, for the filter pickers. */
export async function listAdminLogOptions(actorUserId: string): Promise<AdminLogOptions> {
  await requireHost(actorUserId);

  const competition = await getCompetitionSummary();
  const db = await getDb();
  const teams = await db.all<{ id: string; name: string; sandbox_owner_user_id: string | null }>(
    `SELECT id, name, sandbox_owner_user_id
     FROM teams
     WHERE competition_id = ?
     ORDER BY name`,
    [competition.id],
  );
  const users = await db.all<{ id: string; name: string; role: AdminLogOptions["users"][number]["role"] }>(
    `SELECT id, name, role
     FROM users
     WHERE status <> 'deleted'
     ORDER BY name`,
  );

  return {
    teams: teams.map((team) => ({
      id: team.id,
      name: team.name,
      sandbox: team.sandbox_owner_user_id !== null,
    })),
    users: users.map((user) => ({ id: user.id, name: user.name, role: user.role })),
  };
}
