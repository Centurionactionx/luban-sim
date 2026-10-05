"use client";

import { useRef, useState } from "react";

import { FeedbackForm } from "./feedback-form";
import { ChatIcon } from "./simulator-icons";

/**
 * The header's feedback button and its dialog. Closing keeps an unsent draft;
 * after a send, the next opening starts with a fresh form.
 */
export function FeedbackButton() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [formKey, setFormKey] = useState(0);
  const sentRef = useRef(false);

  const close = () => dialogRef.current?.close();

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="feedback-button"
        aria-label="Send feedback"
        aria-haspopup="dialog"
        title="Send feedback"
        onClick={() => {
          const dialog = dialogRef.current;
          if (!dialog || dialog.open) return;
          dialog.showModal();
          // Start where people type, not on the first radio.
          dialog.querySelector<HTMLTextAreaElement>("textarea")?.focus();
        }}
      >
        <ChatIcon />
      </button>
      <dialog
        ref={dialogRef}
        className="confirm-dialog feedback-dialog"
        aria-labelledby="feedback-dialog-title"
        onClose={() => {
          if (sentRef.current) {
            sentRef.current = false;
            setFormKey((key) => key + 1);
          }
          buttonRef.current?.focus();
        }}
        onClick={(event) => {
          // A click on the backdrop lands on the dialog element itself.
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
      >
        <div className="feedback-dialog__body">
          <h2 id="feedback-dialog-title">Send feedback</h2>
          <FeedbackForm
            key={formKey}
            source="header"
            onCancel={close}
            onClose={close}
            onSent={() => {
              sentRef.current = true;
            }}
          />
        </div>
      </dialog>
    </>
  );
}
