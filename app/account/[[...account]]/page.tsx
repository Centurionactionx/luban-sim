import Link from "next/link";
import { redirect } from "next/navigation";

import { DisplayNameForm } from "@/components/display-name-form";
import { isManagedAuthMode } from "@/lib/server/auth-mode";

export const dynamic = "force-dynamic";

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isManagedAuthMode()) {
    redirect("/");
  }

  const { getManagedSessionState } = await import(
    "@/lib/server/managed-identity"
  );
  const state = await getManagedSessionState();

  if (state.kind === "signed-out") {
    redirect("/sign-in");
  }

  const params = await searchParams;
  const mfaRequired = params.mfa === "required";
  const { UserProfile } = await import("@clerk/nextjs");

  return (
    <main className="auth-page auth-page--wide">
      <section className="auth-page__intro">
        <p className="route-state__brand">Luban Market Lab</p>
        <h1>Account</h1>
        <p>
          Set the name your team sees here. Below, manage your email,
          password, and multi-factor authentication. Host and administrator
          accounts must keep multi-factor authentication enabled.
        </p>
        {state.kind === "linked" ? (
          <DisplayNameForm initialName={state.user.name} />
        ) : null}
        {mfaRequired ? (
          <p className="auth-page__notice" role="alert">
            Multi-factor authentication is required before host controls
            unlock. Open the Security tab below and add an authenticator app,
            then return to the trading room.
          </p>
        ) : null}
        <Link className="button button--secondary" href="/">
          Back to the trading room
        </Link>
      </section>
      <div className="auth-page__card">
        <UserProfile path="/account" />
      </div>
    </main>
  );
}
