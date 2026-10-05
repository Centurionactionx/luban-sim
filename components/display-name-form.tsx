"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState } from "react";

const MAX_LENGTH = 60;

type Status = { kind: "idle" | "saving" | "saved" | "error"; message: string };

/**
 * The name shown in the trading room, your team's member list, and on your
 * trades. Saved in the simulator itself, so it doesn't depend on the
 * sign-in provider's profile.
 */
export function DisplayNameForm({ initialName }: { initialName: string }) {
  const router = useRouter();
  const inputId = useId();
  const statusId = useId();
  const [saved, setSaved] = useState(initialName);
  const [draft, setDraft] = useState(initialName);
  const [status, setStatus] = useState<Status>({ kind: "idle", message: "" });
  const trimmed = draft.replace(/\s+/g, " ").trim();
  const unchanged = trimmed === saved;

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trimmed || unchanged) return;
    setStatus({ kind: "saving", message: "Saving…" });
    try {
      const response = await fetch("/api/account/name", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ name: draft }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        user?: { name: string };
        error?: { message?: string };
      };
      if (!response.ok || !payload.user) {
        throw new Error(payload.error?.message ?? "Your name wasn't saved. Try again.");
      }
      setSaved(payload.user.name);
      setDraft(payload.user.name);
      setStatus({ kind: "saved", message: "Saved. Your team sees the new name." });
      router.refresh();
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Your name wasn't saved. Try again.",
      });
    }
  };

  return (
    <form className="display-name-form" onSubmit={(event) => void save(event)}>
      <label htmlFor={inputId}>Name in the Market Lab</label>
      <div className="display-name-form__row">
        <input
          id={inputId}
          type="text"
          value={draft}
          maxLength={MAX_LENGTH}
          autoComplete="name"
          aria-describedby={statusId}
          aria-invalid={status.kind === "error" ? "true" : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            if (status.kind !== "saving") setStatus({ kind: "idle", message: "" });
          }}
          disabled={status.kind === "saving"}
        />
        <button
          type="submit"
          className="button button--primary"
          disabled={status.kind === "saving" || !trimmed || unchanged}
        >
          {status.kind === "saving" ? "Saving…" : "Save"}
        </button>
      </div>
      <small
        id={statusId}
        className={`display-name-form__status display-name-form__status--${status.kind}`}
        role={status.kind === "error" ? "alert" : "status"}
      >
        {status.message ||
          "Shown in the header, your team's member list, and on your trades."}
      </small>
    </form>
  );
}
