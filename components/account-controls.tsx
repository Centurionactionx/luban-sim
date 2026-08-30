"use client";

import { useClerk } from "@clerk/nextjs";
import Link from "next/link";
import { useState } from "react";

/**
 * Managed-mode header controls: who is signed in, a link to account
 * security (MFA enrollment lives there), and sign-out. Rendered only inside
 * ClerkProvider, i.e. only when LUBAN_AUTH_MODE=managed.
 */
export function AccountControls({
  name,
  initials,
}: {
  name: string;
  initials: string;
}) {
  return (
    <div className="account-controls">
      <span className="account-controls__chip" aria-hidden="true">
        {initials}
      </span>
      <span className="account-controls__name">{name}</span>
      <Link className="account-controls__link" href="/account">
        Account
      </Link>
      <SignOutControl className="account-controls__link" />
    </div>
  );
}

export function SignOutControl({ className }: { className?: string }) {
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
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
