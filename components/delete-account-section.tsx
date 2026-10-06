"use client";

import { useClerk } from "@clerk/nextjs";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useRef, useState } from "react";

import { AccountDeletionFacts } from "./account-deletion-facts";
import styles from "./delete-account-section.module.css";

const CONFIRMATION_WORD = "DELETE";
const DELETED_URL = "/delete-account?deleted=1";

type Status =
  | { kind: "closed" }
  | { kind: "confirming"; message: string }
  | { kind: "deleting" }
  | { kind: "deleted" };

/**
 * Self-service account deletion on the account page. Opens a confirmation
 * that spells out what goes and what stays, asks the person to type DELETE,
 * then calls DELETE /api/account, signs out, and lands on the public
 * /delete-account page's confirmation. Rendered only inside ClerkProvider,
 * i.e. only when LUBAN_AUTH_MODE=managed.
 *
 * `hasMarketLabAccount` is false for a sign-in that never joined through an
 * invitation: there is only the sign-in to delete.
 */
export function DeleteAccountSection({
  hasMarketLabAccount,
}: {
  hasMarketLabAccount: boolean;
}) {
  const { signOut } = useClerk();
  const router = useRouter();
  const headingId = useId();
  const inputId = useId();
  const statusId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>({ kind: "closed" });
  const [typed, setTyped] = useState("");
  const confirmed = typed.trim() === CONFIRMATION_WORD;

  const open = () => {
    setTyped("");
    setStatus({ kind: "confirming", message: "" });
    window.requestAnimationFrame(() => input.current?.focus());
  };

  const remove = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!confirmed || status.kind === "deleting") return;
    setStatus({ kind: "deleting" });

    try {
      const response = await fetch("/api/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ confirmation: CONFIRMATION_WORD }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: { message?: string };
      };
      if (!response.ok || !payload.ok) {
        throw new Error(
          payload.error?.message ?? "Your account wasn't deleted. Try again.",
        );
      }
    } catch (error) {
      setStatus({
        kind: "confirming",
        message:
          error instanceof Error ? error.message : "Your account wasn't deleted. Try again.",
      });
      return;
    }

    setStatus({ kind: "deleted" });
    // The provider has already ended the session along with the user, so
    // signOut may fail; the confirmation page is public either way.
    try {
      await signOut({ redirectUrl: DELETED_URL });
    } catch {
      router.replace(DELETED_URL);
    }
  };

  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <h2 id={headingId}>Delete account</h2>
      <div className={styles.lead}>
        {hasMarketLabAccount
          ? "Permanently delete your Market Lab account and your sign-in. This can't be undone."
          : "You haven't joined a team, so there's only your sign-in to delete. This can't be undone."}{" "}
        <Link href="/delete-account">How deletion works</Link>
      </div>

      {status.kind === "closed" ? (
        <button type="button" className="button button--danger" onClick={open}>
          Delete account…
        </button>
      ) : (
        <form className={styles.confirm} onSubmit={(event) => void remove(event)}>
          {hasMarketLabAccount ? <AccountDeletionFacts className={styles.facts} /> : null}
          <label htmlFor={inputId}>
            Type <strong>{CONFIRMATION_WORD}</strong> to confirm
          </label>
          <input
            ref={input}
            id={inputId}
            type="text"
            value={typed}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            aria-describedby={statusId}
            aria-invalid={status.kind === "confirming" && status.message ? "true" : undefined}
            disabled={status.kind === "deleting" || status.kind === "deleted"}
            onChange={(event) => setTyped(event.target.value)}
          />
          <div className={styles.actions}>
            <button
              type="submit"
              className="button button--danger"
              disabled={!confirmed || status.kind === "deleting" || status.kind === "deleted"}
            >
              {status.kind === "deleting"
                ? "Deleting…"
                : status.kind === "deleted"
                  ? "Signing out…"
                  : "Permanently delete"}
            </button>
            <button
              type="button"
              className="button button--secondary"
              disabled={status.kind === "deleting" || status.kind === "deleted"}
              onClick={() => setStatus({ kind: "closed" })}
            >
              Cancel
            </button>
          </div>
          <small
            id={statusId}
            className={styles.status}
            role={status.kind === "confirming" && status.message ? "alert" : "status"}
          >
            {status.kind === "confirming" ? status.message : null}
            {status.kind === "deleted" ? "Account deleted. Signing you out…" : null}
          </small>
        </form>
      )}
    </section>
  );
}
