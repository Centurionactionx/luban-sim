"use client";

import {
  type FormEvent,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

const MAX_LENGTH = 60;

/** "Later" hides the pop-up on this browser; the bell keeps reminding. */
export function namePromptLaterKey(userId: string): string {
  return `luban.name-prompt-later.${userId}`;
}

function readNamePromptLater(userId: string): boolean {
  try {
    return window.localStorage.getItem(namePromptLaterKey(userId)) === "1";
  } catch {
    return false;
  }
}

const laterListeners = new Set<() => void>();

function subscribeNamePromptLater(listener: () => void): () => void {
  laterListeners.add(listener);
  return () => laterListeners.delete(listener);
}

function writeNamePromptLater(userId: string): void {
  try {
    window.localStorage.setItem(namePromptLaterKey(userId), "1");
  } catch {
    // Storage blocked: the pop-up just shows again next visit.
  }
  for (const listener of laterListeners) listener();
}

/** Whether this browser chose Later; true on the server so nothing flashes. */
export function useNamePromptLater(userId: string): boolean {
  return useSyncExternalStore(
    subscribeNamePromptLater,
    () => readNamePromptLater(userId),
    () => true,
  );
}

/**
 * Asks someone whose account was pre-loaded from the sign-up roster (and so
 * still goes by a placeholder like "User 1") to choose the name their team
 * and the leaderboard show. Pre-filled from their sign-in profile when it
 * has one. "Later" keeps the placeholder; the notifications menu offers the
 * prompt again until a name is saved.
 */
export function DisplayNamePrompt({
  userId,
  open,
  onClose,
  onSaved,
}: {
  userId: string;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputId = useId();
  const statusId = useId();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const suggested = useRef(false);
  const trimmed = draft.replace(/\s+/g, " ").trim();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Pre-fill once from the sign-in profile, unless they've started typing.
  useEffect(() => {
    if (!open || suggested.current) return;
    const controller = new AbortController();
    void fetch("/api/account/name", { credentials: "same-origin", signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { suggestedName?: string | null } | null) => {
        suggested.current = true;
        const name = payload?.suggestedName?.trim();
        if (name) setDraft((current) => current || name.slice(0, MAX_LENGTH));
      })
      .catch(() => {});
    return () => controller.abort();
  }, [open]);

  const later = () => {
    writeNamePromptLater(userId);
    onClose();
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trimmed || saving) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/account/name", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ name: draft }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(payload.error?.message ?? "Your name wasn't saved. Try again.");
      }
      onSaved();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Your name wasn't saved. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog name-prompt"
      aria-labelledby={`${inputId}-title`}
      aria-describedby={`${inputId}-body`}
      onCancel={(event) => {
        event.preventDefault();
        later();
      }}
    >
      <form onSubmit={(event) => void save(event)}>
        <h2 id={`${inputId}-title`}>Set your name</h2>
        <p id={`${inputId}-body`}>
          Your account is ready and you&apos;re on your team. Choose the name your
          teammates and the leaderboard will see.
        </p>
        <label className="name-prompt__label" htmlFor={inputId}>
          Display name
        </label>
        <input
          id={inputId}
          className="name-prompt__input"
          type="text"
          value={draft}
          maxLength={MAX_LENGTH}
          autoComplete="name"
          autoFocus
          aria-describedby={statusId}
          aria-invalid={error ? "true" : undefined}
          disabled={saving}
          onChange={(event) => {
            setDraft(event.target.value);
            setError("");
          }}
        />
        <p id={statusId} className="confirm-dialog__note" role={error ? "alert" : undefined}>
          {error || "You can change it any time from your account."}
        </p>
        <div className="confirm-dialog__actions">
          <button
            type="button"
            className="button button--secondary"
            disabled={saving}
            onClick={later}
          >
            Later
          </button>
          <button
            type="submit"
            className="button button--primary"
            disabled={saving || !trimmed}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
