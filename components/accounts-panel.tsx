"use client";

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { DISPLAY_TIME_ZONE } from "@/lib/time";

import type {
  AccountView,
  AdminOverview,
  CreatedInvitation,
  InvitationSummary,
  UserRole,
} from "@/lib/contracts";

import styles from "./accounts-panel.module.css";

type ApiErrorShape = { error?: { message?: string } };

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function extractError(payload: unknown, fallback: string): string {
  const shaped = payload as ApiErrorShape | null;
  return shaped?.error?.message ?? fallback;
}

function stateLabel(state: InvitationSummary["state"]): string {
  return state.charAt(0).toUpperCase() + state.slice(1);
}

const ROLE_LABELS: Record<UserRole, string> = {
  student: "Student",
  host: "Competition host",
  platform_admin: "Platform admin",
};

/** Someone who signed in within this many days counts as recently active. */
const RECENT_DAYS = 7;

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

function fullDateTime(iso: string): string {
  return (
    new Date(iso).toLocaleString("en-CA", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: DISPLAY_TIME_ZONE,
    }) + " ET"
  );
}

function signedInRecently(iso: string | null): boolean {
  return (
    iso !== null && Date.now() - new Date(iso).getTime() < RECENT_DAYS * 86_400_000
  );
}

/** The roster dot: suspended, signed in this week, or quiet. */
function presence(account: AccountView): { className: string; label: string } {
  if (account.status === "suspended") {
    return { className: `${styles.dot} ${styles.dotSuspended}`, label: "Suspended" };
  }
  return signedInRecently(account.lastLoginAt)
    ? { className: `${styles.dot} ${styles.dotRecent}`, label: "Signed in this week" }
    : { className: styles.dot, label: "Not signed in this week" };
}

function invitationFor(invitation: InvitationSummary): string {
  return invitation.invitedName ?? invitation.email ?? "Anyone with the link";
}

const memberButtonId = (accountId: string) => `account-${accountId}`;
const INVITE_EMAIL_ID = "invite-email";

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
  const [deleteArmed, setDeleteArmed] = useState<string | null>(null);
  const [accountFeedback, setAccountFeedback] = useState("");
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const drawerHeading = useRef<HTMLHeadingElement>(null);

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

  const patchAccount = async (
    userId: string,
    body: Record<string, unknown>,
    workingLabel: string,
  ) => {
    setAccountBusy(userId);
    setAccountFeedback(workingLabel);

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
      setAccountFeedback("");
    } catch (error) {
      setAccountFeedback(
        error instanceof Error ? error.message : "The account could not be updated.",
      );
    } finally {
      setAccountBusy(null);
    }
  };

  const removeAccount = async (userId: string) => {
    if (deleteArmed !== userId) {
      setDeleteArmed(userId);
      setAccountFeedback(
        "Deleting removes this person's access permanently. Click again to confirm.",
      );
      return;
    }

    setDeleteArmed(null);
    setAccountBusy(userId);
    setAccountFeedback("Deleting account…");

    try {
      const response = await fetch(`/api/admin/accounts/${userId}`, {
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
      setAccounts((current) =>
        (current ?? []).filter((row) => row.id !== result.id),
      );
      setAccountFeedback(
        result.mode === "anonymized"
          ? "Account deleted. Their past trades remain on the team ledger, attributed to “Deleted user”."
          : "Account deleted.",
      );
    } catch (error) {
      setAccountFeedback(
        error instanceof Error ? error.message : "The account could not be deleted.",
      );
    } finally {
      setAccountBusy(null);
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

  const selected = accounts?.find((account) => account.id === selectedId) ?? null;

  const selectAccount = (accountId: string) => {
    setSelectedId((current) => (current === accountId ? null : accountId));
    setDeleteArmed(null);
    setAccountFeedback("");
  };

  const closeDrawer = useCallback(() => {
    const returnTo = selectedId;
    setSelectedId(null);
    setDeleteArmed(null);
    setAccountFeedback("");
    if (returnTo) document.getElementById(memberButtonId(returnTo))?.focus();
  }, [selectedId]);

  // Opening someone moves focus into the drawer; Escape closes it again.
  useEffect(() => {
    if (!selectedId) return;
    drawerHeading.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDrawer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, closeDrawer]);

  /** Prefills the invite bar for a team (or a staff role) and jumps to it. */
  const inviteTo = (nextRole: UserRole, nextTeamId?: string) => {
    setRole(nextRole);
    if (nextTeamId) setTeamId(nextTeamId);
    document.getElementById(INVITE_EMAIL_ID)?.focus();
  };

  const teamIds = new Set(teams.map((team) => team.id));
  const students = (accounts ?? []).filter((account) => account.role === "student");
  const staff = (accounts ?? []).filter((account) => account.role !== "student");
  const unassigned = students.filter(
    (account) => !account.teamId || !teamIds.has(account.teamId),
  );
  const openInvitations = (invitations ?? []).filter(
    (invitation) => invitation.state === "active",
  );

  const renderMember = (account: AccountView) => {
    const isSelf = account.id === actorId;
    const dot = presence(account);

    return (
      <li key={account.id}>
        <button
          type="button"
          id={memberButtonId(account.id)}
          className={styles.member}
          aria-expanded={account.id === selectedId}
          aria-controls="account-drawer"
          onClick={() => selectAccount(account.id)}
        >
          <span className={styles.avatar} aria-hidden="true">
            {initials(account.name)}
          </span>
          <span className={styles.memberText}>
            <strong>
              {account.name}
              {isSelf ? " (you)" : ""}
            </strong>
            <small>
              {account.role !== "student"
                ? ROLE_LABELS[account.role]
                : account.status === "suspended"
                  ? "Suspended"
                  : shortSignIn(account.lastLoginAt)}
            </small>
          </span>
          <span className={dot.className} title={dot.label}>
            {/* A suspended person's line already says so. */}
            {account.status !== "suspended" ? (
              <span className="sr-only">{dot.label}</span>
            ) : null}
          </span>
        </button>
      </li>
    );
  };

  const renderTeamCard = (
    key: string,
    title: string,
    members: AccountView[],
    options: {
      waiting?: number;
      flag?: string;
      invite?: { label: string; onClick: () => void };
      empty?: string;
    },
  ) => (
    <section key={key} className={styles.team} aria-label={title}>
      <div className={styles.teamHead}>
        <h3>
          {title}
          {options.flag ? (
            <span className={`invite-state invite-state--revoked ${styles.teamFlag}`}>
              {options.flag}
            </span>
          ) : null}
        </h3>
        <span className={styles.teamCount}>
          {members.length} {members.length === 1 ? "member" : "members"}
          {options.waiting ? ` · ${options.waiting} waiting` : ""}
        </span>
      </div>
      {members.length > 0 ? (
        <ul className={styles.members}>{members.map(renderMember)}</ul>
      ) : (
        <p className={styles.emptyTeam}>
          {options.empty ?? "No members yet."}
          {options.waiting === 1
            ? " An invitation is waiting."
            : options.waiting
              ? ` ${options.waiting} invitations are waiting.`
              : ""}
        </p>
      )}
      {options.invite ? (
        <button type="button" className={styles.addToTeam} onClick={options.invite.onClick}>
          ＋ {options.invite.label}
        </button>
      ) : null}
    </section>
  );

  return (
    <main className="accounts-page">
      <div className="accounts-sheet">
        <header className="accounts-header">
          <div>
            <p className="route-state__brand">Luban Market Lab</p>
            <h1>Accounts &amp; invitations</h1>
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

        <section className={styles.inviteBar} aria-labelledby="invite-heading">
          <form className={styles.inviteForm} onSubmit={(event) => void createInvitation(event)}>
            <h2 id="invite-heading">Invite</h2>
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
              <span className={styles.label}>Email · optional, locks the invite</span>
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
              {busy ? "Creating…" : "Create link"}
            </button>
          </form>

          {created ? (
            <div className="accounts-created" role="status">
              <strong>
                Invitation created. This link is shown once — copy it now and
                send it to the {ROLE_LABELS[created.invitation.role]}.
              </strong>
              <div className="accounts-created__link">
                <code>{created.joinUrl ?? created.joinPath}</code>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => void copyLink()}
                >
                  {copied ? "Copied" : "Copy link"}
                </button>
              </div>
            </div>
          ) : null}

          {feedback ? (
            <p className="accounts-feedback" role="alert">
              {feedback}
            </p>
          ) : null}
        </section>

        <section className={styles.pending} aria-labelledby="pending-heading">
          <h2 id="pending-heading" className={styles.label}>
            Waiting to join
          </h2>
          {invitations === null ? (
            <span className={styles.noPending}>Loading invitations…</span>
          ) : openInvitations.length === 0 ? (
            <span className={styles.noPending}>No open invitations.</span>
          ) : (
            <ul className={styles.pills}>
              {openInvitations.map((invitation) => (
                <li
                  key={invitation.id}
                  className={styles.pill}
                  title={`Expires ${fullDateTime(invitation.expiresAt)}`}
                >
                  {invitationFor(invitation)}
                  <span className={styles.pillTag}>
                    {invitation.teamName ?? ROLE_LABELS[invitation.role]}
                  </span>
                  <button
                    type="button"
                    className={styles.pillRevoke}
                    aria-label={`Revoke the invitation for ${invitationFor(invitation)}`}
                    title="Revoke"
                    onClick={() => void revoke(invitation.id)}
                    disabled={revokeBusy === invitation.id}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className={styles.historyToggle}
            aria-expanded={showHistory}
            aria-controls="invitation-history"
            onClick={() => setShowHistory((open) => !open)}
          >
            {showHistory ? "Hide invitation history" : "Invitation history"}
          </button>
        </section>

        {showHistory ? (
          <section
            id="invitation-history"
            className={styles.history}
            aria-labelledby="invitations-heading"
          >
            <h2 id="invitations-heading" className="sr-only">
              Invitation history
            </h2>
            {invitations === null || invitations.length === 0 ? (
              <p className={styles.note}>No invitations yet.</p>
            ) : (
              <div className="accounts-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Role</th>
                      <th scope="col">For</th>
                      <th scope="col">Team</th>
                      <th scope="col">State</th>
                      <th scope="col">Expires</th>
                      <th scope="col">Created by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invitations.map((invitation) => (
                      <tr key={invitation.id}>
                        <td>{ROLE_LABELS[invitation.role]}</td>
                        <td>{invitationFor(invitation)}</td>
                        <td>{invitation.teamName ?? "—"}</td>
                        <td>
                          <span
                            className={`invite-state invite-state--${invitation.state}`}
                          >
                            {stateLabel(invitation.state)}
                          </span>
                          {invitation.state === "used" && invitation.usedByName
                            ? ` by ${invitation.usedByName}`
                            : null}
                        </td>
                        <td>{fullDateTime(invitation.expiresAt)}</td>
                        <td>{invitation.createdByName ?? "System"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ) : null}

        <div className={styles.body} data-drawer={selected ? "open" : "closed"}>
          <section className={styles.roster} aria-labelledby="roster-heading">
            <h2 id="roster-heading" className="sr-only">
              People by team
            </h2>
            {accounts === null ? (
              <p className={styles.note}>Loading accounts…</p>
            ) : (
              <div className={styles.teams}>
                {teams.map((team) =>
                  renderTeamCard(
                    team.id,
                    team.name,
                    students.filter((account) => account.teamId === team.id),
                    {
                      waiting: openInvitations.filter(
                        (invitation) => invitation.teamId === team.id,
                      ).length,
                      flag: team.status === "active" ? undefined : team.status,
                      invite: {
                        label: "Invite to team",
                        onClick: () => inviteTo("student", team.id),
                      },
                    },
                  ),
                )}
                {unassigned.length > 0
                  ? renderTeamCard("no-team", "No team", unassigned, {})
                  : null}
                {staff.length > 0 || canInviteAdmins
                  ? renderTeamCard("staff", "Staff", staff, {
                      empty: "No hosts or admins yet.",
                      invite: canInviteAdmins
                        ? { label: "Invite a host", onClick: () => inviteTo("host") }
                        : undefined,
                    })
                  : null}
              </div>
            )}
            {accounts !== null ? (
              <div className={styles.legend} aria-hidden="true">
                <span>
                  <i className={`${styles.dot} ${styles.dotRecent}`} />
                  Signed in this week
                </span>
                <span>
                  <i className={styles.dot} />
                  Not recently
                </span>
                <span>
                  <i className={`${styles.dot} ${styles.dotSuspended}`} />
                  Suspended
                </span>
              </div>
            ) : null}
            {!selected && accountFeedback ? (
              <p className="accounts-feedback" role="alert">
                {accountFeedback}
              </p>
            ) : null}
          </section>

          {selected ? (
            <aside
              id="account-drawer"
              className={styles.drawer}
              aria-labelledby="account-drawer-name"
            >
              <div className={styles.drawerTop}>
                <span className={styles.label}>Account</span>
                <button
                  type="button"
                  className={styles.close}
                  aria-label="Close account details"
                  onClick={closeDrawer}
                >
                  ×
                </button>
              </div>
              {(() => {
                const isSelf = selected.id === actorId;
                const rowBusy = accountBusy === selected.id;
                const first = firstName(selected.name);

                return (
                  <>
                    <div className={styles.who}>
                      <span className={styles.avatar} aria-hidden="true">
                        {initials(selected.name)}
                      </span>
                      <div>
                        <h3 id="account-drawer-name" ref={drawerHeading} tabIndex={-1}>
                          {selected.name}
                          {isSelf ? " (you)" : ""}
                        </h3>
                        <p>{selected.email}</p>
                      </div>
                    </div>

                    <dl className={styles.facts}>
                      <dt className={styles.label}>Role</dt>
                      <dd>
                        {canInviteAdmins && !isSelf ? (
                          <select
                            aria-label={`Role for ${selected.name}`}
                            value={selected.role}
                            disabled={rowBusy}
                            onChange={(event) =>
                              void patchAccount(
                                selected.id,
                                { role: event.target.value },
                                "Changing role…",
                              )
                            }
                          >
                            <option value="student">Student</option>
                            <option value="host">Host</option>
                            <option value="platform_admin">Platform admin</option>
                          </select>
                        ) : (
                          ROLE_LABELS[selected.role]
                        )}
                      </dd>
                      <dt className={styles.label}>Team</dt>
                      <dd>
                        {selected.role === "student" && !isSelf ? (
                          <select
                            aria-label={`Team for ${selected.name}`}
                            value={selected.teamId ?? ""}
                            disabled={rowBusy}
                            onChange={(event) =>
                              void patchAccount(
                                selected.id,
                                { teamId: event.target.value || null },
                                "Moving team…",
                              )
                            }
                          >
                            <option value="">No team</option>
                            {teams.map((team) => (
                              <option key={team.id} value={team.id}>
                                {team.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          selected.teamName ?? "—"
                        )}
                      </dd>
                      <dt className={styles.label}>Status</dt>
                      <dd>
                        <span
                          className={`invite-state invite-state--${selected.status === "active" ? "active" : "revoked"}`}
                        >
                          {selected.status}
                        </span>
                      </dd>
                      <dt className={styles.label}>Last sign-in</dt>
                      <dd className={styles.mono}>
                        {selected.lastLoginAt ? fullDateTime(selected.lastLoginAt) : "Never"}
                      </dd>
                      <dt className={styles.label}>Joined</dt>
                      <dd className={styles.mono}>{fullDateTime(selected.createdAt)}</dd>
                      <dt className={styles.label}>Trades</dt>
                      <dd className={styles.mono}>{selected.orderCount}</dd>
                    </dl>

                    {!isSelf ? (
                      <button
                        type="button"
                        className="button button--secondary"
                        disabled={rowBusy}
                        onClick={() =>
                          void patchAccount(
                            selected.id,
                            {
                              status:
                                selected.status === "active" ? "suspended" : "active",
                            },
                            selected.status === "active" ? "Suspending…" : "Restoring…",
                          )
                        }
                      >
                        {selected.status === "active" ? "Suspend account" : "Restore account"}
                      </button>
                    ) : null}

                    {canInviteAdmins && !isSelf ? (
                      <div className={styles.dangerZone}>
                        <span className={styles.label}>Delete account</span>
                        <p>
                          {selected.orderCount > 0
                            ? `${first}'s ${selected.orderCount} ${selected.orderCount === 1 ? "trade stays" : "trades stay"} on ${selected.teamName ?? "the team"}'s ledger as “Deleted user”.`
                            : `${first} has no trades, so the account is removed completely.`}
                          {managed
                            ? " Their sign-in at the identity provider isn't touched, so they can be invited again later."
                            : ""}
                        </p>
                        <button
                          type="button"
                          className="button button--danger accounts-revoke"
                          disabled={rowBusy}
                          onClick={() => void removeAccount(selected.id)}
                        >
                          {deleteArmed === selected.id ? `Confirm: delete ${first}` : `Delete ${first}`}
                        </button>
                      </div>
                    ) : null}

                    {accountFeedback ? (
                      <p className={`accounts-feedback ${styles.drawerFeedback}`} role="alert">
                        {accountFeedback}
                      </p>
                    ) : null}
                  </>
                );
              })()}
            </aside>
          ) : null}
        </div>
      </div>
    </main>
  );
}
