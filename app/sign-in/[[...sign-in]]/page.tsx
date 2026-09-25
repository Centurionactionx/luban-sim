import Link from "next/link";

import { LegalNote } from "@/components/legal-note";
import { isManagedAuthMode } from "@/lib/server/auth-mode";

export const dynamic = "force-dynamic";

export default async function SignInPage() {
  if (!isManagedAuthMode()) {
    return (
      <main className="route-state" aria-labelledby="signin-demo-title">
        <section className="route-state__sheet">
          <p className="route-state__brand">Luban Market Lab</p>
          <h1 id="signin-demo-title">This prototype uses demo identities.</h1>
          <p>
            Real sign-in is available when the deployment runs with
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

  const { SignIn } = await import("@clerk/nextjs");

  return (
    <main className="auth-page">
      <section className="auth-page__intro">
        <p className="route-state__brand">Luban Market Lab</p>
        <h1>Sign in to your team&apos;s trading room.</h1>
        <p>
          Use the email address your invitation was sent to. New here?
          Registration works only through an invitation link from your
          competition host.
        </p>
        <LegalNote />
      </section>
      <div className="auth-page__card">
        <SignIn path="/sign-in" signUpUrl="/sign-up" />
      </div>
    </main>
  );
}
