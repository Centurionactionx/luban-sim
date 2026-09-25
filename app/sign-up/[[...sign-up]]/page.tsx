import Link from "next/link";

import { LegalNote } from "@/components/legal-note";
import { isManagedAuthMode } from "@/lib/server/auth-mode";

export const dynamic = "force-dynamic";

export default async function SignUpPage() {
  if (!isManagedAuthMode()) {
    return (
      <main className="route-state" aria-labelledby="signup-demo-title">
        <section className="route-state__sheet">
          <p className="route-state__brand">Luban Market Lab</p>
          <h1 id="signup-demo-title">This prototype uses demo identities.</h1>
          <p>
            Registration is available when the deployment runs with
            LUBAN_AUTH_MODE=managed. In demo mode, open the trading room and
            use the identity switcher instead.
          </p>
          <Link className="button button--primary" href="/">
            Open the trading room
          </Link>
        </section>
      </main>
    );
  }

  const { SignUp } = await import("@clerk/nextjs");

  return (
    <main className="auth-page">
      <section className="auth-page__intro">
        <p className="route-state__brand">Luban Market Lab</p>
        <h1>Create your account.</h1>
        <p>
          Luban accounts are invitation-only. After you verify your email,
          return to your invitation link — it places you on your team. Signing
          up without an invitation does not grant access to any competition.
        </p>
        <LegalNote />
      </section>
      <div className="auth-page__card">
        <SignUp path="/sign-up" signInUrl="/sign-in" />
      </div>
    </main>
  );
}
