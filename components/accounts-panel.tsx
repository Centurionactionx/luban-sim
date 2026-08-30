"use client";

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useState } from "react";

import type {
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
  canInviteAdmins,
}: {
  managed: boolean;
  canInviteAdmins: boolean;
}) {
  const [invitations, setInvitations] = useState<InvitationSummary[] | null>(
    null,
  );
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
      const [inviteResponse, overviewResponse] = await Promise.all([
        fetch("/api/admin/invitations", {
          cache: "no-store",
          credentials: "same-origin",
        }),
        fetch("/api/admin/overview", {
          cache: "no-store",
          credentials: "same-origin",
        }),
      ]);

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
                        })}
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
