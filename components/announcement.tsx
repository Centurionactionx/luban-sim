"use client";

import { type FormEvent, useEffect, useState } from "react";

import { extractError, readJson } from "@/lib/api-client";
import type { Announcement, AnnouncementTone } from "@/lib/contracts";
import { DISPLAY_TIME_ZONE } from "@/lib/time";

import styles from "./announcement.module.css";
import { CloseIcon, MegaphoneIcon } from "./simulator-icons";

/** Mirrors the server's limits in lib/server/admin.ts. */
const TITLE_MAX_LENGTH = 80;
const BODY_MAX_LENGTH = 500;
const DISMISSED_KEY = "luban.announcement-dismissed";

function postedAt(iso: string): string {
  return new Date(iso).toLocaleString("en-CA", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: DISPLAY_TIME_ZONE,
  });
}

function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

/**
 * The host's notice above the trading room. Closing it hides this one
 * announcement in this browser; a new post shows again.
 */
export function AnnouncementBanner({ announcement }: { announcement: Announcement | null }) {
  // undefined until read after mount, so a closed notice never flashes.
  const [dismissed, setDismissed] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const timer = window.setTimeout(() => setDismissed(readDismissed()), 0);
    return () => window.clearTimeout(timer);
  }, []);
  if (!announcement || dismissed === undefined || dismissed === announcement.createdAt) {
    return null;
  }

  const dismiss = () => {
    setDismissed(announcement.createdAt);
    try {
      window.localStorage.setItem(DISMISSED_KEY, announcement.createdAt);
    } catch {
      // Private mode: it stays closed until the page reloads.
    }
  };

  return (
    <section
      className={styles.banner}
      data-tone={announcement.tone}
      role={announcement.tone === "urgent" ? "alert" : "status"}
      aria-label="Host announcement"
    >
      <div className={styles.content}>
        <div className={styles.meta}>
          <MegaphoneIcon className={styles.icon} />
          <span className={styles.kicker}>
            {announcement.tone === "urgent" ? "Urgent" : "Announcement"}
          </span>
          <span className={styles.byline}>
            {announcement.authorName} · {postedAt(announcement.createdAt)}
          </span>
        </div>
        <h2 className={styles.title}>{announcement.title}</h2>
        {announcement.body ? <p className={styles.body}>{announcement.body}</p> : null}
      </div>
      <button
        type="button"
        className={styles.close}
        aria-label="Dismiss announcement"
        onClick={dismiss}
      >
        <CloseIcon width={18} height={18} />
      </button>
    </section>
  );
}

/** Host controls: post, replace, or clear the announcement. */
export function AnnouncementForm({
  announcement,
  onChanged,
}: {
  announcement: Announcement | null;
  onChanged: () => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tone, setTone] = useState<AnnouncementTone>("normal");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");

  const send = async (method: "PUT" | "DELETE") => {
    setBusy(true);
    setFeedback("");
    try {
      const response = await fetch("/api/admin/announcement", {
        method,
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        ...(method === "PUT" ? { body: JSON.stringify({ title, body, tone }) } : {}),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(extractError(payload, "The announcement did not change."));
      }
      if (method === "PUT") {
        setTitle("");
        setBody("");
        setTone("normal");
      }
      setFeedback(method === "PUT" ? "Announcement posted." : "Announcement cleared.");
      await onChanged();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "The announcement did not change.");
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!title.trim()) {
      setFeedback("Give the announcement a title.");
      return;
    }
    void send("PUT");
  };

  return (
    <details className="host-schedule">
      <summary className="host-schedule__heading">
        <strong>
          Announcement
          {announcement ? <em className={styles.live}>Live</em> : null}
        </strong>
        <span>
          {announcement
            ? `Showing now: “${announcement.title}”. Posting replaces it.`
            : "Shown to everyone above the trading room."}
        </span>
      </summary>
    <form className="host-schedule__body" aria-label="Announcement" onSubmit={submit}>
      <label htmlFor="announcement-title">
        <span>Title</span>
        <input
          id="announcement-title"
          type="text"
          maxLength={TITLE_MAX_LENGTH}
          autoComplete="off"
          placeholder="Holiday Monday"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          disabled={busy}
        />
      </label>
      <label htmlFor="announcement-body">
        <span>Message · optional</span>
        <textarea
          id="announcement-body"
          rows={3}
          maxLength={BODY_MAX_LENGTH}
          placeholder="Markets are closed Monday. Orders placed over the weekend wait until Tuesday's open."
          value={body}
          onChange={(event) => setBody(event.target.value)}
          disabled={busy}
        />
      </label>
      <label htmlFor="announcement-tone">
        <span>Tone</span>
        <select
          id="announcement-tone"
          value={tone}
          onChange={(event) => setTone(event.target.value as AnnouncementTone)}
          disabled={busy}
        >
          <option value="normal">Normal</option>
          <option value="urgent">Urgent</option>
        </select>
      </label>
      <div className={styles.formActions}>
        <button className="button button--secondary" type="submit" disabled={busy}>
          {announcement ? "Replace announcement" : "Post announcement"}
        </button>
        {announcement ? (
          <button
            className="button button--secondary"
            type="button"
            onClick={() => void send("DELETE")}
            disabled={busy}
          >
            Clear
          </button>
        ) : null}
      </div>
      <p className="host-schedule__note" role="status" aria-live="polite">
        {feedback}
      </p>
    </form>
    </details>
  );
}
