"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import {
  FEEDBACK_MAX_LENGTH,
  FEEDBACK_MIN_LENGTH,
  type FeedbackSource,
  type FeedbackTopic,
} from "@/lib/contracts";

const TOPIC_OPTIONS: Array<{ value: FeedbackTopic; label: string; hint: string }> = [
  { value: "WEBSITE", label: "Website", hint: "lubancanada.com" },
  { value: "SIMULATOR", label: "Simulator", hint: "This Market Lab" },
];

type SendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent" }
  | { kind: "error"; message: string };

type ApiErrorShape = { error?: { message?: string } };

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

const SEND_FAILED = "Your feedback could not be sent. Check your connection and try again.";

/**
 * The feedback form shared by the header dialog and the /feedback page. The
 * sender is the signed-in account, so it asks only what it is about and what
 * they want to say. A failed send keeps the text so nothing is lost.
 */
export function FeedbackForm({
  source,
  initialTopic = "SIMULATOR",
  onCancel,
  onClose,
  onSent,
}: {
  source: FeedbackSource;
  initialTopic?: FeedbackTopic;
  /** Shows a Cancel button (the dialog); the page has its own way back. */
  onCancel?: () => void;
  /** Shows Close after sending; without it the page links back instead. */
  onClose?: () => void;
  onSent?: () => void;
}) {
  const id = useId();
  const [topic, setTopic] = useState<FeedbackTopic>(initialTopic);
  const [message, setMessage] = useState("");
  const [state, setState] = useState<SendState>({ kind: "idle" });
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const doneRef = useRef<HTMLParagraphElement>(null);
  const focusMessageNext = useRef(false);

  // The form is replaced by the thank-you once sent, so move focus with it;
  // "Send more" brings focus back to the empty message box.
  useEffect(() => {
    if (state.kind === "sent") {
      doneRef.current?.focus();
    } else if (state.kind === "idle" && focusMessageNext.current) {
      focusMessageNext.current = false;
      messageRef.current?.focus();
    }
  }, [state.kind]);

  const sending = state.kind === "sending";

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending) return;

    const trimmed = message.trim();
    if (trimmed.length < FEEDBACK_MIN_LENGTH) {
      setState({
        kind: "error",
        message: `Write at least ${FEEDBACK_MIN_LENGTH} characters.`,
      });
      messageRef.current?.focus();
      return;
    }

    setState({ kind: "sending" });
    let response: Response;
    try {
      response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ topic, message: trimmed, source }),
      });
    } catch {
      setState({ kind: "error", message: SEND_FAILED });
      return;
    }

    if (!response.ok) {
      const payload = (await readJson(response)) as ApiErrorShape | null;
      setState({ kind: "error", message: payload?.error?.message ?? SEND_FAILED });
      return;
    }

    setMessage("");
    setState({ kind: "sent" });
    onSent?.();
  }

  if (state.kind === "sent") {
    return (
      <div className="feedback-form feedback-form--done" role="status">
        <p className="feedback-form__done-title" ref={doneRef} tabIndex={-1}>
          Thanks for the feedback.
        </p>
        <p>
          It went straight to the Luban team. If we need more detail, we&apos;ll
          get in touch.
        </p>
        <div className="feedback-form__actions">
          <button
            type="button"
            className="button button--secondary"
            onClick={() => {
              focusMessageNext.current = true;
              setState({ kind: "idle" });
            }}
          >
            Send more
          </button>
          {onClose ? (
            <button type="button" className="button button--primary" onClick={onClose}>
              Close
            </button>
          ) : (
            <Link className="button button--primary" href="/">
              Back to the Market Lab
            </Link>
          )}
        </div>
      </div>
    );
  }

  const countId = `${id}-count`;
  const noteId = `${id}-note`;
  const errorId = `${id}-error`;

  return (
    <form className="feedback-form" onSubmit={(event) => void send(event)} noValidate>
      <fieldset className="feedback-form__fields" disabled={sending}>
        <fieldset className="feedback-topic">
          <legend>What is it about?</legend>
          <div className="feedback-topic__options">
            {TOPIC_OPTIONS.map((option) => (
              <label key={option.value} className="feedback-topic__option">
                <input
                  type="radio"
                  name={`${id}-topic`}
                  value={option.value}
                  checked={topic === option.value}
                  onChange={() => setTopic(option.value)}
                />
                <span>{option.label}</span>
                <small>{option.hint}</small>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="feedback-form__message">
          <div className="feedback-form__label-row">
            <label htmlFor={`${id}-message`}>Your feedback</label>
            <span id={countId} className="feedback-form__count">
              {message.length} / {FEEDBACK_MAX_LENGTH}
              <span className="sr-only"> characters</span>
            </span>
          </div>
          <textarea
            ref={messageRef}
            id={`${id}-message`}
            name="message"
            rows={6}
            maxLength={FEEDBACK_MAX_LENGTH}
            required
            value={message}
            onChange={(event) => {
              setMessage(event.target.value);
              if (state.kind === "error") setState({ kind: "idle" });
            }}
            aria-describedby={`${countId} ${noteId}${state.kind === "error" ? ` ${errorId}` : ""}`}
            aria-invalid={state.kind === "error" ? true : undefined}
            placeholder="What worked, what didn't, or what you'd like to see."
          />
        </div>

        <p id={noteId} className="feedback-form__note">
          We&apos;ll see your name and team with this so we can follow up.
        </p>

        {state.kind === "error" ? (
          <p id={errorId} className="feedback-form__error" role="alert">
            {state.message}
          </p>
        ) : null}

        <div className="feedback-form__actions">
          {onCancel ? (
            <button type="button" className="button button--secondary" onClick={onCancel}>
              Cancel
            </button>
          ) : null}
          <button type="submit" className="button button--primary">
            {sending ? "Sending…" : "Send feedback"}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
