"use client";

import { useClerk } from "@clerk/nextjs";
import Link from "next/link";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import {
  ChatIcon,
  ChevronDownIcon,
  FlaskIcon,
  SignOutIcon,
  UserIcon,
} from "./simulator-icons";

/** How long the menu waits before closing once the pointer leaves it. */
const CLOSE_DELAY_MS = 180;

/**
 * Managed-mode header controls: who is signed in, with a menu holding the
 * account page (MFA enrollment lives there), sign-out, and for platform
 * administrators their tools. The menu opens on hover, and on a click or
 * keyboard press for touch screens and keyboards. Rendered only inside
 * ClerkProvider, i.e. only when LUBAN_AUTH_MODE=managed.
 */
export function AccountControls({
  name,
  initials,
  isPlatformAdmin = false,
}: {
  name: string;
  initials: string;
  isPlatformAdmin?: boolean;
}) {
  return (
    <AccountMenu
      name={name}
      initials={initials}
      isPlatformAdmin={isPlatformAdmin}
      signOut={
        <SignOutControl
          className="account-controls__item account-controls__item--sign-out"
          icon={<SignOutIcon />}
        />
      }
    />
  );
}

/** The menu itself, with no sign-in provider of its own. */
export function AccountMenu({
  name,
  initials,
  isPlatformAdmin,
  signOut,
}: {
  name: string;
  initials: string;
  isPlatformAdmin: boolean;
  signOut: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<number | null>(null);

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const closeSoon = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  useEffect(() => cancelClose, []);

  return (
    <div
      ref={root}
      className="account-controls"
      data-open={open}
      onPointerEnter={(event) => {
        if (event.pointerType !== "mouse") return;
        cancelClose();
        setOpen(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") closeSoon();
      }}
      onBlur={(event) => {
        // Tabbing out of the menu closes it.
        if (!root.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="account-controls__trigger"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`${name}: account menu`}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="account-controls__chip" aria-hidden="true">
          {initials}
        </span>
        <span className="account-controls__name">{name}</span>
        <ChevronDownIcon className="account-controls__chevron" aria-hidden="true" />
      </button>
      <div id={menuId} className="account-controls__menu" hidden={!open}>
        <ul>
          <li>
            <Link className="account-controls__item" href="/account">
              <UserIcon />
              Account
            </Link>
          </li>
          {isPlatformAdmin ? (
            <>
              <li>
                <a className="account-controls__item" href="/admin/valuation-lab">
                  <FlaskIcon />
                  Past → Present valuation lab
                </a>
              </li>
              <li>
                <a className="account-controls__item" href="/admin/feedback">
                  <ChatIcon />
                  User feedback
                </a>
              </li>
            </>
          ) : null}
          <li className="account-controls__divider">{signOut}</li>
        </ul>
      </div>
    </div>
  );
}

export function SignOutControl({
  className,
  icon,
}: {
  className?: string;
  icon?: ReactNode;
}) {
  const { signOut } = useClerk();
  const [busy, setBusy] = useState(false);

  return (
    <button
      className={className}
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void signOut({ redirectUrl: "/sign-in" });
      }}
    >
      {icon}
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
