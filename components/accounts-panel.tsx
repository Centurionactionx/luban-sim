"use client";

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useState } from "react";

import { DISPLAY_TIME_ZONE } from "@/lib/time";

import type {
  AccountView,
  AdminOverview,
  CreatedInvitation,
  InvitationSummary,
  UserRole,
} from "@/lib/contracts";

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

        <section className="accounts-list" aria-labelledby="users-heading">
          <h2 id="users-heading">User accounts</h2>
          {accounts === null ? (
            <p>Loading accounts…</p>
          ) : accounts.length === 0 ? (
            <p>No accounts yet.</p>
          ) : (
            <div className="accounts-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Email</th>
                    <th scope="col">Role</th>
                    <th scope="col">Team</th>
                    <th scope="col">Status</th>
                    <th scope="col">Last sign-in</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((account) => {
                    const isSelf = account.id === actorId;
                    const rowBusy = accountBusy === account.id;

                    return (
                      <tr key={account.id}>
                        <td>{account.name}{isSelf ? " (you)" : ""}</td>
                        <td>{account.email}</td>
                        <td>
                          {canInviteAdmins && !isSelf ? (
                            <select
                              aria-label={`Role for ${account.name}`}
                              value={account.role}
                              disabled={rowBusy}
                              onChange={(event) =>
                                void patchAccount(
                                  account.id,
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
                            ROLE_LABELS[account.role]
                          )}
                        </td>
                        <td>
                          {account.role === "student" && !isSelf ? (
                            <select
                              aria-label={`Team for ${account.name}`}
                              value={account.teamId ?? ""}
                              disabled={rowBusy}
                              onChange={(event) =>
                                void patchAccount(
                                  account.id,
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
                            account.teamName ?? "—"
                          )}
                        </td>
                        <td>
                          <span className={`invite-state invite-state--${account.status === "active" ? "active" : "revoked"}`}>
                            {account.status}
                          </span>
                        </td>
                        <td>
                          {account.lastLoginAt
                            ? new Date(account.lastLoginAt).toLocaleString("en-CA", {
                                dateStyle: "medium",
                                timeStyle: "short",
                                timeZone: DISPLAY_TIME_ZONE,
                              }) + " ET"
                            : "Never"}
                        </td>
                        <td>
                          {!isSelf ? (
                            <div className="accounts-row-actions">
                              <button
                                type="button"
                                className="button button--secondary accounts-revoke"
                                disabled={rowBusy}
                                onClick={() =>
                                  void patchAccount(
                                    account.id,
                                    {
                                      status:
                                        account.status === "active"
                                          ? "suspended"
                                          : "active",
                                    },
                                    account.status === "active"
                                      ? "Suspending…"
                                      : "Restoring…",
                                  )
                                }
                              >
                                {account.status === "active" ? "Suspend" : "Restore"}
                              </button>
                              {canInviteAdmins ? (
                                <button
                                  type="button"
                                  className="button button--danger accounts-revoke"
                                  disabled={rowBusy}
                                  onClick={() => void removeAccount(account.id)}
                                >
                                  {deleteArmed === account.id
                                    ? "Confirm delete"
                                    : "Delete"}
                                </button>
                              ) : null}
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {managed ? (
            <p className="accounts-note" role="note">
              Deleting an account removes the person&apos;s access and identity
              here; their sign-in at the identity provider is not touched, so
              they can be invited again later. Accounts with recorded trades
              are anonymized so team ledgers stay intact.
            </p>
          ) : null}
          {accountFeedback ? (
            <p className="accounts-feedback" role="alert">
              {accountFeedback}
            </p>
          ) : null}
        </section>

        <section className="accounts-create" aria-labelledby="invite-heading">
          <h2 id="invite-heading">Invite someone</h2>
          <form onSubmit={(event) => void createInvitation(event)}>
            <div className="accounts-form-grid">
              <label>
                <span>Role</span>
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
                  <span>Team</span>
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
                <span>Email (optional, locks the invite)</span>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="student@example.ca"
                  maxLength={254}
                  disabled={busy}
                />
              </label>
              <label>
                <span>Name (optional)</span>
                <input
                  type="text"
                  value={invitedName}
                  onChange={(event) => setInvitedName(event.target.value)}
                  placeholder="Jordan Lee"
                  maxLength={80}
                  disabled={busy}
                />
              </label>
            </div>
            <button
              className="button button--primary"
              type="submit"
              disabled={busy || (role === "student" && !teamId)}
            >
              {busy ? "Creating…" : "Create invitation"}
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

        <section className="accounts-list" aria-labelledby="invitations-heading">
          <h2 id="invitations-heading">Issued invitations</h2>
          {invitations === null ? (
            <p>Loading invitations…</p>
          ) : invitations.length === 0 ? (
            <p>No invitations yet. Create one above to register a student.</p>
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
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {invitations.map((invitation) => (
                    <tr key={invitation.id}>
                      <td>{ROLE_LABELS[invitation.role]}</td>
                      <td>
                        {invitation.invitedName ?? invitation.email ?? "Anyone with the link"}
                      </td>
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
                      <td>
                        {new Date(invitation.expiresAt).toLocaleString("en-CA", {
                          dateStyle: "medium",
                          timeStyle: "short",
                          timeZone: DISPLAY_TIME_ZONE,
                        })}{" "}
                        ET
                      </td>
                      <td>{invitation.createdByName ?? "System"}</td>
                      <td>
                        {invitation.state === "active" ? (
                          <button
                            type="button"
                            className="button button--danger accounts-revoke"
                            onClick={() => void revoke(invitation.id)}
                            disabled={revokeBusy === invitation.id}
                          >
                            {revokeBusy === invitation.id ? "Revoking…" : "Revoke"}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
