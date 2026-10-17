"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";

import { extractError, readJson } from "@/lib/api-client";

import styles from "./wrapped-publish.module.css";

/** Shown to everyone once the host has published Wrapped. */
export function WrappedBanner() {
  return (
    <Link className={styles.banner} href="/wrapped">
      <strong>Your competition, wrapped.</strong>
      <span>See your Wrapped</span>
    </Link>
  );
}

/** Host control: publish (or refresh) Wrapped with the publish code, once the competition has ended. */
export function WrappedPublishForm({
  ended,
  published,
  onChanged,
}: {
  ended: boolean;
  published: boolean;
  onChanged: () => Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!code.trim()) {
      setFeedback("Enter the publish code.");
      return;
    }
    setBusy(true);
    setFeedback("");
    try {
      const response = await fetch("/api/admin/wrapped", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      const payload = await readJson(response);
      if (!response.ok) throw new Error(extractError(payload, "Wrapped was not published."));
      setCode("");
      setFeedback("Wrapped is live.");
      await onChanged();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Wrapped was not published.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="host-schedule">
      <summary className="host-schedule__heading">
        <strong>Wrapped</strong>
        <span>
          {!ended
            ? "Available once the competition has ended."
            : published
              ? "Live for everyone. Republish to refresh the stats."
              : "Publish the end-of-competition story for everyone."}
        </span>
      </summary>
      <form className="host-schedule__body" aria-label="Publish Wrapped" onSubmit={submit}>
        <label htmlFor="wrapped-code">
          <span>Publish code</span>
          <input
            id="wrapped-code"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            disabled={busy || !ended}
          />
        </label>
        <button className="button button--secondary" type="submit" disabled={busy || !ended}>
          {published ? "Republish Wrapped" : "Publish Wrapped"}
        </button>
        <p className="host-schedule__note" role="status" aria-live="polite">
          {feedback}
        </p>
      </form>
    </details>
  );
}
