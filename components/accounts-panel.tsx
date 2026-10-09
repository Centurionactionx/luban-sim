"use client";

import Link from "next/link";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { DISPLAY_TIME_ZONE } from "@/lib/time";
import { extractError, readJson } from "@/lib/api-client";

import type {
  AccountView,
  AdminOverview,
  AdminTeamSummary,
  CreatedInvitation,
  InvitationSummary,
  TeamStatus,
  UserRole,
} from "@/lib/contracts";

import styles from "./accounts-panel.module.css";

function stateLabel(state: InvitationSummary["state"]): string {
  return state.charAt(0).toUpperCase() + state.slice(1);
}

const ROLE_LABELS: Record<UserRole, string> = {
  student: "Student",
  host: "Competition host",
  platform_admin: "Platform admin",
};

/** Two letters for the avatar, skipping brackets and other punctuation. */
function initials(name: string): string {
  const words = Array.from(name.matchAll(/[\p{L}\p{N}]+/gu), (match) => match[0]);
  const first = words[0] ?? "?";
  const last = words.length > 1 ? (words[words.length - 1] ?? "") : "";
  return (last ? first.charAt(0) + last.charAt(0) : first.slice(0, 2)).toUpperCase();
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

function dayKey(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: DISPLAY_TIME_ZONE });
}

/** "Today 9:41 a.m.", "Yesterday", or "Oct. 3", in Eastern time. */
function shortSignIn(iso: string | null): string {
  if (!iso) return "Never signed in";
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (dayKey(date) === dayKey(today)) {
    const time = date.toLocaleTimeString("en-CA", {
      timeStyle: "short",
      timeZone: DISPLAY_TIME_ZONE,
    });
    return `Today ${time}`;
  }
  if (dayKey(date) === dayKey(yesterday)) return "Yesterday";
  return date.toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
    timeZone: DISPLAY_TIME_ZONE,
  });
}

/** "Oct. 13", in Eastern time. */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
    timeZone: DISPLAY_TIME_ZONE,
  });
}

function invitationFor(invitation: InvitationSummary): string {
  return invitation.invitedName ?? invitation.email ?? "Anyone with the link";
}

/** Mirrors the server's limits in lib/server/admin.ts. */
const TEAM_NAME_MAX_LENGTH = 80;
const MAX_TEAM_CASH_CENTS = 100_000_000_000_000;

const currency = new Intl.NumberFormat("en-CA", {
  style: "currency",
  currency: "CAD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatMoney(cents: number): string {
  return currency.format(cents / 100);
}

/** Dollars typed by a host, as cents; null unless it is a valid amount. */
function parseCashDraft(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) return null;
  const [wholeDollars, fractionalDollars = ""] = normalized.split(".");
  const cents = Number(wholeDollars) * 100 + Number(fractionalDollars.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents >= 0 && cents <= MAX_TEAM_CASH_CENTS
    ? cents
    : null;
}

const memberRowId = (accountId: string) => `account-${accountId}`;
const editButtonId = (teamId: string, field: "name" | "cash") => `team-${field}-${teamId}`;

const SHORT_ROLE_LABELS: Record<UserRole, string> = {
  student: "Student",
  host: "Host",
  platform_admin: "Admin",
};

function roleClass(role: UserRole): string {
  return role === "platform_admin" ? styles.pillAdmin : role === "host" ? styles.pillHost : "";
}

/** Focuses an inline editor's input once, when it opens. */
function focusOnMount(node: HTMLInputElement | null) {
  if (!node) return;
  node.focus();
  node.select();
}

function PencilGlyph() {
  return (
    <svg className={styles.pencil} viewBox="0 0 24 24" aria-hidden="true">
      <path d="m4 20 4.1-1 10.7-10.7a2.1 2.1 0 0 0-3-3L5.1 16 4 20Z" />
    </svg>
  );
}
const INVITE_EMAIL_ID = "invite-email";
/** How long the undo notice stays up. */
const TOAST_MS = 8_000;

/**
 * A small panel under a button: the ··· menus. Clicking outside or pressing
 * Escape closes it, and Escape hands focus back to the button.
 */
function Popover({
  open,
  onOpenChange,
  label,
  buttonClassName,
  buttonContent,
  align = "end",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  buttonClassName?: string;
  buttonContent: ReactNode;
  align?: "start" | "end";
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onOpenChange(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, onOpenChange]);

  return (
    <div className={styles.popover} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={buttonClassName}
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => onOpenChange(!open)}
      >
        {buttonContent}
      </button>
      <div
        id={panelId}
        className={styles.popoverPanel}
        data-align={align}
        role="group"
        aria-label={label}
        hidden={!open}
      >
        {children}
      </div>
    </div>
  );
}

type Toast = {
  id: number;
  message: string;
  tone: "info" | "error";
  undo?: () => Promise<void>;
};

type Confirm = { kind: "delete" | "remove" | "disqualify"; id: string };

type Editing = { teamId: string; field: "name" | "cash"; draft: string };

export function AccountsPanel({
  managed,
  actorId,
  canInviteAdmins,
}: {
  managed: boolean;
  actorId: string;
  canInviteAdmins: boolean;
}) {
  const [invitations, setInvitations] = useState<InvitationSummary[] | null>(
    null,
  );
  const [accounts, setAccounts] = useState<AccountView[] | null>(null);
  const [accountBusy, setAccountBusy] = useState<string | null>(null);
  const [teams, setTeams] = useState<AdminOverview["teams"]>([]);
  const [role, setRole] = useState<UserRole>("student");
  const [teamId, setTeamId] = useState("");
  const [email, setEmail] = useState("");
  const [invitedName, setInvitedName] = useState("");
  const [busy, setBusy] = useState(false);
  const [revokeBusy, setRevokeBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [created, setCreated] = useState<CreatedInvitation & { joinUrl?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [query, setQuery] = useState("");
  const [newTeamName, setNewTeamName] = useState("");
  const [teamBusy, setTeamBusy] = useState<string | null>(null);
  const [addTeamFeedback, setAddTeamFeedback] = useState("");
  // Inline editing: at most one ··· menu, one edited field, and one
  // confirmation open at a time; quick changes report in an undo notice.
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  const load = useCallback(async () => {
    try {
      const [inviteResponse, overviewResponse, accountsResponse] =
        await Promise.all([
          fetch("/api/admin/invitations", {
            cache: "no-store",
            credentials: "same-origin",
          }),
          fetch("/api/admin/overview", {
            cache: "no-store",
            credentials: "same-origin",
          }),
          fetch("/api/admin/accounts", {
            cache: "no-store",
            credentials: "same-origin",
          }),
        ]);

      const accountsPayload = await readJson(accountsResponse);
      if (accountsResponse.ok) {
        setAccounts((accountsPayload as { accounts: AccountView[] }).accounts);
      } else {
        setAccounts((current) => current ?? []);
      }

      const invitePayload = await readJson(inviteResponse);
      if (!inviteResponse.ok) {
        throw new Error(
          extractError(invitePayload, "Invitations could not be loaded."),
        );
      }
      setInvitations(
        (invitePayload as { invitations: InvitationSummary[] }).invitations,
      );

      const overviewPayload = await readJson(overviewResponse);
      if (overviewResponse.ok) {
        const overview = overviewPayload as AdminOverview;
        setTeams(overview.teams);
        setTeamId((current) => current || overview.teams[0]?.id || "");
      }
    } catch (error) {
      setFeedback(
        error instanceof Error ? error.message : "Invitations could not be loaded.",
      );
      setInvitations((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const createInvitation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setFeedback("");
    setCreated(null);
    setCopied(false);

    try {
      const response = await fetch("/api/admin/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          role,
          ...(role === "student" ? { teamId } : {}),
          ...(email.trim() ? { email: email.trim() } : {}),
          ...(invitedName.trim() ? { invitedName: invitedName.trim() } : {}),
        }),
      });

      const payload = await readJson(response);

      if (!response.ok) {
        throw new Error(
          extractError(payload, "The invitation could not be created."),
        );
      }

      const result = payload as CreatedInvitation & { joinUrl: string };
      setCreated(result);
      setInvitations((current) => [
        result.invitation,
        ...(current ?? []),
      ]);
      setEmail("");
      setInvitedName("");
      setFeedback("");
    } catch (error) {
      setFeedback(
        error instanceof Error ? error.message : "The invitation could not be created.",
      );
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (invitationId: string) => {
    setRevokeBusy(invitationId);
    setFeedback("");

    try {
      const response = await fetch(`/api/admin/invitations/${invitationId}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const payload = await readJson(response);

      if (!response.ok) {
        throw new Error(
          extractError(payload, "The invitation could not be revoked."),
        );
      }

      const { invitation } = payload as { invitation: InvitationSummary };
      setInvitations((current) =>
        (current ?? []).map((item) =>
          item.id === invitation.id ? invitation : item,
        ),
      );
    } catch (error) {
      setFeedback(
        error instanceof Error ? error.message : "The invitation could not be revoked.",
      );
    } finally {
      setRevokeBusy(null);
    }
  };

  const copyLink = async () => {
    if (!created?.joinUrl) return;

    try {
      await navigator.clipboard.writeText(created.joinUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setFeedback("Copy failed — select the link text and copy it manually.");
    }
  };

  const showToast = (message: string, tone: Toast["tone"] = "info", undo?: Toast["undo"]) => {
    // A fresh id restarts the notice's timer even for a repeated message.
    setToast((current) => ({ id: (current?.id ?? 0) + 1, message, tone, undo }));
  };

  // The notice clears itself; a newer one restarts the clock.
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(
      () => setToast((current) => (current?.id === toast.id ? null : current)),
      TOAST_MS,
    );
    return () => window.clearTimeout(timer);
  }, [toast]);

  const undoToast = async () => {
    const undo = toast?.undo;
    setToast(null);
    if (undo) await undo();
  };

  /** Re-reads accounts after a team change renames or unassigns people. */
  const refreshAccounts = async () => {
    const response = await fetch("/api/admin/accounts", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) return;
    const payload = (await readJson(response)) as { accounts: AccountView[] };
    setAccounts(payload.accounts);
  };

  /** One account change; returns the updated account, or null after an error notice. */
  const patchAccount = async (
    userId: string,
    body: Record<string, unknown>,
  ): Promise<AccountView | null> => {
    setAccountBusy(userId);
    try {
      const response = await fetch(`/api/admin/accounts/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(extractError(payload, "The account could not be updated."));
      }
      const { account } = payload as { account: AccountView };
      setAccounts((current) =>
        (current ?? []).map((row) => (row.id === account.id ? account : row)),
      );
      return account;
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "The account could not be updated.",
        "error",
      );
      return null;
    } finally {
      setAccountBusy(null);
    }
  };

  /** A reversible account change: applies it, then offers Undo. */
  const changeAccount = async (
    account: AccountView,
    body: Record<string, unknown>,
    undoBody: Record<string, unknown>,
    message: string,
  ) => {
    setMenuOpen(null);
    const updated = await patchAccount(account.id, body);
    if (!updated) return;
    showToast(message, "info", async () => {
      if (await patchAccount(account.id, undoBody)) showToast("Undone.");
    });
  };

  const teamName = (id: string | null) =>
    teams.find((team) => team.id === id)?.name ?? "no team";

  const moveAccount = (account: AccountView, nextTeamId: string | null) => {
    if (nextTeamId === account.teamId) {
      setMenuOpen(null);
      return;
    }
    void changeAccount(
      account,
      { teamId: nextTeamId },
      { teamId: account.teamId },
      nextTeamId
        ? `${account.name} moved to ${teamName(nextTeamId)}.`
        : `${account.name} has no team now.`,
    );
  };

  const deleteAccount = async (account: AccountView) => {
    setConfirm(null);
    setAccountBusy(account.id);
    try {
      const response = await fetch(`/api/admin/accounts/${account.id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(extractError(payload, "The account could not be deleted."));
      }
      const { result } = payload as {
        result: { id: string; mode: "deleted" | "anonymized" };
      };
      setAccounts((current) => (current ?? []).filter((row) => row.id !== result.id));
      showToast(
        result.mode === "anonymized"
          ? `${account.name}'s account was deleted. Their trades stay on the team ledger as “Deleted user”.`
          : `${account.name}'s account was deleted.`,
      );
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "The account could not be deleted.",
        "error",
      );
    } finally {
      setAccountBusy(null);
    }
  };

  const copyEmail = async (account: AccountView) => {
    setMenuOpen(null);
    try {
      await navigator.clipboard.writeText(account.email);
      showToast(`Copied ${account.email}.`);
    } catch {
      showToast("Copy failed — select the email and copy it yourself.", "error");
    }
  };

  /**
   * Sends one team change. Every team route answers with the fresh overview,
   * so the list updates from the server's own view of the teams.
   */
  const teamRequest = async (
    busyKey: string,
    path: string,
    init: RequestInit,
    fallback: string,
  ): Promise<boolean> => {
    setTeamBusy(busyKey);
    try {
      const response = await fetch(path, {
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        ...init,
      });
      const payload = await readJson(response);
      if (!response.ok) throw new Error(extractError(payload, fallback));
      const overview = payload as AdminOverview;
      setTeams(overview.teams);
      setTeamId((current) =>
        overview.teams.some((team) => team.id === current)
          ? current
          : (overview.teams[0]?.id ?? ""),
      );
      void refreshAccounts();
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : fallback, "error");
      return false;
    } finally {
      setTeamBusy(null);
    }
  };

  const patchTeam = (team: AdminTeamSummary, body: Record<string, unknown>, fallback: string) =>
    teamRequest(
      `${team.id}`,
      `/api/admin/teams/${encodeURIComponent(team.id)}`,
      { method: "PATCH", body: JSON.stringify(body) },
      fallback,
    );

  const putTeamCash = (team: AdminTeamSummary, cashCents: number) =>
    teamRequest(
      `${team.id}`,
      `/api/admin/teams/${encodeURIComponent(team.id)}/cash`,
      { method: "PATCH", body: JSON.stringify({ cashCents }) },
      "The cash balance did not change.",
    );

  const addTeam = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = newTeamName.trim();
    if (!name) return;
    setAddTeamFeedback("");
    const added = await teamRequest(
      "create",
      "/api/admin/teams",
      { method: "POST", body: JSON.stringify({ name }) },
      "The team could not be added.",
    );
    if (added) {
      setNewTeamName("");
      setAddTeamFeedback(`${name} was added with the competition's starting cash.`);
    }
  };

  const startEditing = (team: AdminTeamSummary, field: Editing["field"]) => {
    setMenuOpen(null);
    setConfirm(null);
    setEditing({
      teamId: team.id,
      field,
      draft: field === "name" ? team.name : (team.cashCents / 100).toFixed(2),
    });
  };

  const stopEditing = (team: AdminTeamSummary, field: Editing["field"]) => {
    setEditing(null);
    // Back to the value the edit started from.
    window.setTimeout(() => document.getElementById(editButtonId(team.id, field))?.focus(), 0);
  };

  const saveEdit = async (event: FormEvent<HTMLFormElement>, team: AdminTeamSummary) => {
    event.preventDefault();
    if (!editing) return;
    if (editing.field === "name") {
      const name = editing.draft.trim();
      if (!name) return;
      if (name === team.name) return stopEditing(team, "name");
      if (await patchTeam(team, { name }, "The team could not be renamed.")) {
        stopEditing(team, "name");
        showToast(`${team.name} is now ${name}.`, "info", async () => {
          if (await patchTeam(team, { name: team.name }, "The team could not be renamed.")) {
            showToast("Undone.");
          }
        });
      }
      return;
    }
    const cashCents = parseCashDraft(editing.draft);
    if (cashCents === null) {
      showToast("Enter a non-negative CAD amount with no more than two decimal places.", "error");
      return;
    }
    if (cashCents === team.cashCents) return stopEditing(team, "cash");
    if (await putTeamCash(team, cashCents)) {
      stopEditing(team, "cash");
      showToast(`${team.name}'s cash is now ${formatMoney(cashCents)}.`, "info", async () => {
        if (await putTeamCash(team, team.cashCents)) showToast("Undone.");
      });
    }
  };

  const changeStanding = async (team: AdminTeamSummary, status: TeamStatus) => {
    if (status === team.status) return;
    if (status === "disqualified" && !(confirm?.kind === "disqualify" && confirm.id === team.id)) {
      setConfirm({ kind: "disqualify", id: team.id });
      return;
    }
    setConfirm(null);
    if (await patchTeam(team, { status }, "The team's standing did not change.")) {
      const message =
        status === "active"
          ? `${team.name} is active again.`
          : status === "frozen"
            ? `${team.name} is frozen. Its portfolio is kept and new trades are blocked.`
            : `${team.name} is disqualified and out of the standings.`;
      showToast(message, "info", async () => {
        if (await patchTeam(team, { status: team.status }, "The team's standing did not change.")) {
          showToast("Undone.");
        }
      });
    }
  };

  const removeTeam = async (team: AdminTeamSummary) => {
    setConfirm(null);
    const memberCount = team.memberNames.length;
    const removed = await teamRequest(
      team.id,
      `/api/admin/teams/${encodeURIComponent(team.id)}`,
      { method: "DELETE" },
      "The team could not be removed.",
    );
    if (removed) {
      showToast(
        memberCount === 0
          ? `${team.name} was removed.`
          : memberCount === 1
            ? `${team.name} was removed. Its member has no team now.`
            : `${team.name} was removed. Its ${memberCount} members have no team now.`,
      );
    }
  };

  /** Prefills the invite panel for a team (or a staff role) and jumps to it. */
  const inviteTo = (nextRole: UserRole, nextTeamId?: string) => {
    setRole(nextRole);
    if (nextTeamId) setTeamId(nextTeamId);
    document.getElementById(INVITE_EMAIL_ID)?.focus();
  };

  const search = query.trim().toLowerCase();
  const matches = (account: AccountView) =>
    !search ||
    account.name.toLowerCase().includes(search) ||
    account.email.toLowerCase().includes(search);

  const teamIds = new Set(teams.map((team) => team.id));
  const people = accounts ?? [];
  const students = people.filter((account) => account.role === "student");
  const staff = people.filter((account) => account.role !== "student");
  const unassigned = students.filter(
    (account) => !account.teamId || !teamIds.has(account.teamId),
  );
  const openInvitations = (invitations ?? []).filter(
    (invitation) => invitation.state === "active",
  );
  const closedInvitations = (invitations ?? []).filter(
    (invitation) => invitation.state !== "active",
  );
  const shownCount = people.filter(matches).length;

  const renderConfirm = (
    label: string,
    detail: string,
    action: string,
    onConfirm: () => void,
  ) => (
    <div className={styles.confirm} role="alertdialog" aria-label={label}>
      <div>
        <strong>{label}</strong>
        <p>{detail}</p>
      </div>
      <div className={styles.confirmActions}>
        <button
          type="button"
          className="button button--secondary button--compact"
          onClick={() => setConfirm(null)}
        >
          Cancel
        </button>
        <button
          type="button"
          className={`button button--compact ${styles.dangerButton}`}
          onClick={onConfirm}
        >
          {action}
        </button>
      </div>
    </div>
  );

  const renderPerson = (account: AccountView) => {
    const isSelf = account.id === actorId;
    const rowBusy = accountBusy === account.id;
    const first = firstName(account.name);
    const menuKey = `person:${account.id}`;
    const canChangeRole = canInviteAdmins && !isSelf;
    const canDelete = canInviteAdmins && !isSelf;

    return (
      <li key={account.id} id={memberRowId(account.id)}>
        <div className={styles.person} data-busy={rowBusy || undefined}>
          <span className={styles.personCell}>
            <span className={styles.avatar} aria-hidden="true">
              {initials(account.name)}
            </span>
            <span className={styles.who}>
              <strong>{account.name}</strong>
              <small>
                {account.email}
                {isSelf ? " · you" : ""}
              </small>
            </span>
          </span>

          <span className={styles.cell}>
            {canChangeRole ? (
              <select
                className={`${styles.pill} ${roleClass(account.role)}`}
                aria-label={`Role for ${account.name}`}
                value={account.role}
                disabled={rowBusy}
                onChange={(event) => {
                  const next = event.target.value as UserRole;
                  void changeAccount(
                    account,
                    { role: next },
                    { role: account.role },
                    `${account.name} is now a ${ROLE_LABELS[next].toLowerCase()}.`,
                  );
                }}
              >
                <option value="student">Student</option>
                <option value="host">Host</option>
                <option value="platform_admin">Admin</option>
              </select>
            ) : (
              <span className={`${styles.pill} ${styles.pillStatic} ${roleClass(account.role)}`}>
                <span className="sr-only">Role: </span>
                {SHORT_ROLE_LABELS[account.role]}
              </span>
            )}
          </span>

          <span className={styles.cell}>
            {isSelf ? (
              <span className={`${styles.pill} ${styles.pillStatic} ${styles.pillActive}`}>
                <span className="sr-only">Status: </span>Active
              </span>
            ) : (
              <select
                className={`${styles.pill} ${account.status === "active" ? styles.pillActive : styles.pillWarn}`}
                aria-label={`Status for ${account.name}`}
                value={account.status}
                disabled={rowBusy}
                onChange={(event) => {
                  const next = event.target.value as AccountView["status"];
                  void changeAccount(
                    account,
                    { status: next },
                    { status: account.status },
                    next === "suspended"
                      ? `${account.name} is suspended and can't sign in.`
                      : `${account.name} is active again.`,
                  );
                }}
              >
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
              </select>
            )}
          </span>

          <span className={`${styles.cell} ${styles.num} ${styles.colTrades}`}>
            <span className="sr-only">Trades: </span>
            {account.orderCount}
          </span>
          <span className={`${styles.cell} ${styles.mono} ${styles.colJoined}`}>
            <span className="sr-only">Joined </span>
            {shortDate(account.createdAt)}
          </span>
          <span className={`${styles.cell} ${styles.mono} ${styles.colSignIn}`}>
            <span className="sr-only">Last sign-in: </span>
            {account.lastLoginAt ? shortSignIn(account.lastLoginAt) : "Never"}
          </span>

          <span className={styles.cellEnd}>
            {!isSelf ? (
              <Popover
                open={menuOpen === menuKey}
                onOpenChange={(open) => {
                  setMenuOpen(open ? menuKey : null);
                  if (open) setConfirm(null);
                }}
                label={`More actions for ${account.name}`}
                buttonClassName={styles.more}
                buttonContent={<span aria-hidden="true">···</span>}
              >
                {account.role === "student" ? (
                  <>
                    <p className={styles.menuHeading}>Move {first} to</p>
                    {[...teams.map((team) => ({ id: team.id as string | null, name: team.name })), { id: null, name: "No team" }].map(
                      (option) => (
                        <button
                          key={option.id ?? "none"}
                          type="button"
                          className={styles.menuItem}
                          aria-pressed={option.id === account.teamId}
                          disabled={rowBusy}
                          onClick={() => moveAccount(account, option.id)}
                        >
                          <span className={styles.menuBadge} aria-hidden="true">
                            {option.id ? initials(option.name) : "–"}
                          </span>
                          {option.name}
                          {option.id === account.teamId ? (
                            <span className={styles.check} aria-hidden="true">
                              ✓
                            </span>
                          ) : null}
                        </button>
                      ),
                    )}
                    <hr className={styles.menuRule} />
                  </>
                ) : null}
                <button
                  type="button"
                  className={styles.menuItem}
                  onClick={() => void copyEmail(account)}
                >
                  Copy email
                </button>
                {canDelete ? (
                  <button
                    type="button"
                    className={`${styles.menuItem} ${styles.menuDanger}`}
                    onClick={() => {
                      setMenuOpen(null);
                      setConfirm({ kind: "delete", id: account.id });
                    }}
                  >
                    Delete {first}…
                    <small>
                      {account.orderCount > 0
                        ? `${account.orderCount} ${account.orderCount === 1 ? "trade stays" : "trades stay"} as “Deleted user”`
                        : "No trades · removes the account"}
                    </small>
                  </button>
                ) : null}
              </Popover>
            ) : null}
          </span>
        </div>
        {confirm?.kind === "delete" && confirm.id === account.id
          ? renderConfirm(
              `Delete ${account.name}?`,
              (account.orderCount > 0
                ? `Their ${account.orderCount} ${account.orderCount === 1 ? "trade stays" : "trades stay"} on ${account.teamName ?? "the team"}'s ledger as “Deleted user”.`
                : `${first} has no trades, so the account is removed completely.`) +
                (managed
                  ? " Their sign-in at the identity provider isn't touched, so they can be invited again."
                  : ""),
              `Delete ${first}`,
              () => void deleteAccount(account),
            )
          : null}
      </li>
    );
  };

  const renderEditable = (team: AdminTeamSummary, field: Editing["field"]) => {
    const isEditing = editing?.teamId === team.id && editing.field === field;
    const working = teamBusy === team.id;

    if (isEditing && editing) {
      return (
        <form
          className={`${styles.inlineEdit} ${field === "cash" ? styles.inlineCash : ""}`}
          onSubmit={(event) => void saveEdit(event, team)}
        >
          {field === "cash" ? (
            <span className={styles.cashPrefix} aria-hidden="true">
              $
            </span>
          ) : null}
          <input
            ref={focusOnMount}
            type={field === "cash" ? "number" : "text"}
            aria-label={field === "cash" ? `Cash for ${team.name}` : `New name for ${team.name}`}
            {...(field === "cash"
              ? { min: "0", max: "1000000000000", step: "0.01", inputMode: "decimal" as const }
              : { maxLength: TEAM_NAME_MAX_LENGTH, autoComplete: "off" })}
            value={editing.draft}
            onChange={(event) => setEditing({ ...editing, draft: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                stopEditing(team, field);
              }
            }}
            disabled={working}
          />
          <button
            type="submit"
            className={styles.saveEdit}
            aria-label={field === "cash" ? "Save cash" : "Save name"}
            disabled={working}
          >
            ✓
          </button>
          <button
            type="button"
            className={styles.cancelEdit}
            aria-label="Cancel"
            onClick={() => stopEditing(team, field)}
            disabled={working}
          >
            ✕
          </button>
        </form>
      );
    }

    return (
      <button
        type="button"
        id={editButtonId(team.id, field)}
        className={field === "cash" ? styles.editCash : styles.editName}
        aria-label={field === "cash" ? `Set cash for ${team.name}` : `Rename ${team.name}`}
        title={field === "cash" ? "Set cash" : "Rename"}
        onClick={() => startEditing(team, field)}
        disabled={teamBusy !== null}
      >
        <span>{field === "cash" ? formatMoney(team.cashCents) : team.name}</span>
        <PencilGlyph />
      </button>
    );
  };

  const renderGroup = (
    key: string,
    title: string,
    members: AccountView[],
    options: {
      detail?: string;
      badge?: "team" | "staff" | "none";
      invite?: { label: string; onClick: () => void };
      team?: AdminTeamSummary;
    } = {},
  ) => {
    const visible = members.filter(matches);
    // A search hides groups with nobody matching.
    if (search && visible.length === 0) return null;
    const team = options.team;
    const menuKey = `team:${key}`;

    return (
      <section key={key} className={styles.group} aria-label={title}>
        <div className={styles.groupHead}>
          <span
            className={`${styles.badge} ${options.badge === "staff" ? styles.badgeStaff : options.badge === "none" ? styles.badgeNone : ""}`}
            aria-hidden="true"
          >
            {options.badge === "none" ? "–" : initials(title)}
          </span>
          <div className={styles.groupTitle}>
            {team ? (
              <h3>{renderEditable(team, "name")}</h3>
            ) : (
              <h3>{title}</h3>
            )}
            {team ? (
              <select
                className={`${styles.pill} ${team.status === "active" ? styles.pillActive : styles.pillWarn}`}
                aria-label={`Standing for ${team.name}`}
                value={team.status}
                disabled={teamBusy !== null}
                onChange={(event) => void changeStanding(team, event.target.value as TeamStatus)}
              >
                <option value="active">Active</option>
                <option value="frozen">Frozen</option>
                <option value="disqualified">Disqualified</option>
              </select>
            ) : null}
            {options.detail ? <span className={styles.groupDetail}>{options.detail}</span> : null}
          </div>
          <div className={styles.groupTools}>
            {team ? (
              <span className={styles.cashTool}>
                <span className={styles.label}>Cash</span>
                {renderEditable(team, "cash")}
              </span>
            ) : null}
            {options.invite ? (
              <button
                type="button"
                className={styles.groupInvite}
                onClick={options.invite.onClick}
              >
                ＋ {options.invite.label}
              </button>
            ) : null}
            {team ? (
              <Popover
                open={menuOpen === menuKey}
                onOpenChange={(open) => setMenuOpen(open ? menuKey : null)}
                label={`More team actions for ${team.name}`}
                buttonClassName={styles.more}
                buttonContent={<span aria-hidden="true">···</span>}
              >
                <button
                  type="button"
                  className={styles.menuItem}
                  onClick={() => startEditing(team, "name")}
                >
                  Rename team
                </button>
                <button
                  type="button"
                  className={styles.menuItem}
                  onClick={() => startEditing(team, "cash")}
                >
                  Set cash
                </button>
                <hr className={styles.menuRule} />
                <button
                  type="button"
                  className={`${styles.menuItem} ${styles.menuDanger}`}
                  onClick={() => {
                    setMenuOpen(null);
                    setConfirm({ kind: "remove", id: team.id });
                  }}
                >
                  Remove team…
                  <small>Deletes its portfolio and trades</small>
                </button>
              </Popover>
            ) : null}
          </div>
        </div>

        {team && confirm?.kind === "disqualify" && confirm.id === team.id
          ? renderConfirm(
              `Disqualify ${team.name}?`,
              "It leaves the standings and can't trade. You can restore it later.",
              `Disqualify ${team.name}`,
              () => void changeStanding(team, "disqualified"),
            )
          : null}
        {team && confirm?.kind === "remove" && confirm.id === team.id
          ? renderConfirm(
              `Remove ${team.name}?`,
              `Deletes its portfolio and ${team.tradeCount} ${team.tradeCount === 1 ? "trade" : "trades"} for good. ${
                team.memberNames.length === 0
                  ? "It has no members."
                  : `Its ${team.memberNames.length} ${team.memberNames.length === 1 ? "member stays" : "members stay"}, with no team.`
              }`,
              `Remove ${team.name}`,
              () => void removeTeam(team),
            )
          : null}

        {visible.length > 0 ? (
          <ul className={styles.people}>{visible.map(renderPerson)}</ul>
        ) : (
          <p className={styles.empty}>No members yet.</p>
        )}
      </section>
    );
  };

  const teamDetail = (memberCount: number, waiting: number) =>
    `${memberCount} ${memberCount === 1 ? "member" : "members"}` +
    (waiting ? ` · ${waiting} ${waiting === 1 ? "invite" : "invites"} waiting` : "");

  return (
    <main className="accounts-page">
      <div className="accounts-sheet">
        <header className="accounts-header">
          <div>
            <p className="route-state__brand">Luban Market Lab</p>
            <h1>Team &amp; user management</h1>
          </div>
          <Link className="button button--secondary" href="/">
            Back to the trading room
          </Link>
        </header>

        {!managed ? (
          <p className="accounts-note" role="note">
            Demo mode: invitations can be created and revoked for testing, but
            the join links can only be redeemed on a deployment running
            managed sign-in (LUBAN_AUTH_MODE=managed).
          </p>
        ) : null}

        <div className={styles.layout}>
          <aside className={styles.side}>
            <section className={styles.sideSection} aria-labelledby="invite-heading">
              <h2 id="invite-heading">Invite someone</h2>
              <form className={styles.inviteForm} onSubmit={(event) => void createInvitation(event)}>
                <label>
                  <span className={styles.label}>Role</span>
                  <select
                    value={role}
                    onChange={(event) => setRole(event.target.value as UserRole)}
                    disabled={busy}
                  >
                    <option value="student">Student</option>
                    {canInviteAdmins ? (
                      <>
                        <option value="host">Competition host</option>
                        <option value="platform_admin">Platform admin</option>
                      </>
                    ) : null}
                  </select>
                </label>
                {role === "student" ? (
                  <label>
                    <span className={styles.label}>Team</span>
                    <select
                      value={teamId}
                      onChange={(event) => setTeamId(event.target.value)}
                      disabled={busy || teams.length === 0}
                      required
                    >
                      {teams.length === 0 ? (
                        <option value="">No teams available</option>
                      ) : null}
                      {teams.map((team) => (
                        <option key={team.id} value={team.id}>
                          {team.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label>
                  <span className={styles.label}>Email · locks the invite</span>
                  <input
                    id={INVITE_EMAIL_ID}
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="student@example.ca"
                    maxLength={254}
                    disabled={busy}
                  />
                </label>
                <label>
                  <span className={styles.label}>Name · optional</span>
                  <input
                    type="text"
                    value={invitedName}
                    onChange={(event) => setInvitedName(event.target.value)}
                    placeholder="Jordan Lee"
                    maxLength={80}
                    disabled={busy}
                  />
                </label>
                <button
                  className="button button--primary"
                  type="submit"
                  disabled={busy || (role === "student" && !teamId)}
                >
                  {busy ? "Creating…" : "Create invitation link"}
                </button>
              </form>

              {created ? (
                <div className={styles.created} role="status">
                  <span className={styles.label}>Link ready · shown once</span>
                  <p>
                    Copy it now and send it to the{" "}
                    {ROLE_LABELS[created.invitation.role].toLowerCase()}.
                  </p>
                  <code>{created.joinUrl ?? created.joinPath}</code>
                  <button
                    className="button button--secondary button--compact"
                    type="button"
                    onClick={() => void copyLink()}
                  >
                    {copied ? "Copied" : "Copy link"}
                  </button>
                </div>
              ) : null}

              {feedback ? (
                <p className="accounts-feedback" role="alert">
                  {feedback}
                </p>
              ) : null}
            </section>

            <section className={styles.sideSection} aria-labelledby="add-team-heading">
              <h2 id="add-team-heading">Add a team</h2>
              <form className={styles.inviteForm} onSubmit={(event) => void addTeam(event)}>
                <label>
                  <span className={styles.label}>Team name</span>
                  <input
                    type="text"
                    maxLength={TEAM_NAME_MAX_LENGTH}
                    autoComplete="off"
                    value={newTeamName}
                    onChange={(event) => setNewTeamName(event.target.value)}
                    placeholder="Bay St Bulls"
                    disabled={teamBusy !== null}
                  />
                </label>
                <button
                  className="button button--secondary"
                  type="submit"
                  disabled={teamBusy !== null || !newTeamName.trim()}
                >
                  {teamBusy === "create" ? "Adding…" : "Add team"}
                </button>
              </form>
              <p className={styles.sideFeedback} role="status" aria-live="polite">
                {addTeamFeedback}
              </p>
            </section>

            <section className={styles.sideSection} aria-labelledby="open-invitations-heading">
              <h2 id="open-invitations-heading">
                Open invitations · {openInvitations.length}
              </h2>
              {invitations === null ? (
                <p className={styles.empty}>Loading invitations…</p>
              ) : openInvitations.length === 0 ? (
                <p className={styles.empty}>No open invitations.</p>
              ) : (
                <ul className={styles.invites}>
                  {openInvitations.map((invitation) => (
                    <li key={invitation.id}>
                      <div>
                        <strong>{invitationFor(invitation)}</strong>
                        <small>
                          {ROLE_LABELS[invitation.role]}
                          {invitation.teamName ? ` · ${invitation.teamName}` : ""} · expires{" "}
                          {shortDate(invitation.expiresAt)}
                        </small>
                      </div>
                      <button
                        type="button"
                        className="button button--danger accounts-revoke"
                        aria-label={`Revoke the invitation for ${invitationFor(invitation)}`}
                        onClick={() => void revoke(invitation.id)}
                        disabled={revokeBusy === invitation.id}
                      >
                        {revokeBusy === invitation.id ? "Revoking…" : "Revoke"}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {closedInvitations.length > 0 ? (
                <>
                  <button
                    type="button"
                    className={styles.historyToggle}
                    aria-expanded={showHistory}
                    aria-controls="invitation-history"
                    onClick={() => setShowHistory((open) => !open)}
                  >
                    {showHistory ? "Hide" : "Show"} used &amp; expired ({closedInvitations.length})
                  </button>
                  {showHistory ? (
                    <ul
                      id="invitation-history"
                      className={`${styles.invites} ${styles.history}`}
                      aria-label="Invitation history"
                    >
                      {closedInvitations.map((invitation) => (
                        <li key={invitation.id}>
                          <div>
                            <strong>{invitationFor(invitation)}</strong>
                            <small>
                              {ROLE_LABELS[invitation.role]}
                              {invitation.teamName ? ` · ${invitation.teamName}` : ""}
                              {invitation.state === "used" && invitation.usedByName
                                ? ` · joined as ${invitation.usedByName}`
                                : ""}
                            </small>
                          </div>
                          <span className={`invite-state invite-state--${invitation.state}`}>
                            {stateLabel(invitation.state)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : null}
            </section>
          </aside>

          <section className={styles.main} aria-labelledby="people-heading">
            <div className={styles.mainHead}>
              <h2 id="people-heading">
                People · {search ? `${shownCount} of ${people.length}` : people.length}
              </h2>
              <label className={styles.search}>
                <span className="sr-only">Search people</span>
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search name or email"
                />
              </label>
            </div>

            <div className={styles.columns} aria-hidden="true">
              <span>Person</span>
              <span>Role</span>
              <span>Status</span>
              <span className={`${styles.num} ${styles.colTrades}`}>Trades</span>
              <span className={styles.colJoined}>Joined</span>
              <span className={styles.colSignIn}>Last sign-in</span>
              <span />
            </div>

            {accounts === null ? (
              <p className={styles.empty}>Loading accounts…</p>
            ) : (
              <>
                {/* Teams with people first, then the empty ones. */}
                {[...teams]
                  .sort(
                    (left, right) =>
                      Number(!students.some((account) => account.teamId === left.id)) -
                      Number(!students.some((account) => account.teamId === right.id)),
                  )
                  .map((team) => {
                    const members = students.filter((account) => account.teamId === team.id);
                    const waiting = openInvitations.filter(
                      (invitation) => invitation.teamId === team.id,
                    ).length;
                    return renderGroup(team.id, team.name, members, {
                      detail: teamDetail(members.length, waiting),
                      badge: "team",
                      invite: { label: "Invite", onClick: () => inviteTo("student", team.id) },
                      team,
                    });
                  })}
                {unassigned.length > 0
                  ? renderGroup("no-team", "No team", unassigned, {
                      detail: teamDetail(unassigned.length, 0),
                      badge: "none",
                    })
                  : null}
                {staff.length > 0
                  ? renderGroup("staff", "Staff", staff, {
                      detail: "Hosts & admins",
                      badge: "staff",
                      invite: canInviteAdmins
                        ? { label: "Invite a host", onClick: () => inviteTo("host") }
                        : undefined,
                    })
                  : null}
                {search && shownCount === 0 ? (
                  <p className={styles.empty}>Nobody matches “{query.trim()}”.</p>
                ) : null}
              </>
            )}
          </section>
        </div>
      </div>

      <div className={styles.toastRegion} role="status" aria-live="polite">
        {toast ? (
          <div className={`${styles.toast} ${toast.tone === "error" ? styles.toastError : ""}`}>
            <span>{toast.message}</span>
            {toast.undo ? (
              <button type="button" className={styles.toastUndo} onClick={() => void undoToast()}>
                Undo
              </button>
            ) : null}
            <button
              type="button"
              className={styles.toastClose}
              aria-label="Dismiss"
              onClick={() => setToast(null)}
            >
              ✕
            </button>
          </div>
        ) : null}
      </div>
    </main>
  );
}
