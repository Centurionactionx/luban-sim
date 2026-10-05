import { redirect } from "next/navigation";

import {
  AccountControls,
  SignOutControl,
} from "@/components/account-controls";
import { SimulatorApp } from "@/components/simulator-app";
import { isManagedAuthMode } from "@/lib/server/auth-mode";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (!isManagedAuthMode()) {
    return <SimulatorApp />;
  }

  const { getManagedSessionState } = await import(
    "@/lib/server/managed-identity"
  );
  const state = await getManagedSessionState();

  if (state.kind === "signed-out") {
    redirect("/sign-in");
  }

  if (state.kind === "suspended") {
    return (
      <main className="route-state" aria-labelledby="suspended-title">
        <section className="route-state__sheet">
          <p className="route-state__brand">Luban Market Lab</p>
          <h1 id="suspended-title">This account is suspended.</h1>
          <p>
            Your sign-in works, but a host or administrator has suspended this
            Luban account. Contact your competition host if you believe this is
            a mistake.
          </p>
          <SignOutControl className="button button--secondary" />
        </section>
      </main>
    );
  }

  if (state.kind === "unlinked") {
    return (
      <main className="route-state" aria-labelledby="no-access-title">
        <section className="route-state__sheet">
          <p className="route-state__brand">Luban Market Lab</p>
          <h1 id="no-access-title">Almost there — an invitation is required.</h1>
          <p>
            You are signed in, but this sign-in is not linked to a Luban
            account yet. Registration works only through an invitation link
            from a competition host. If you received one, open that link while
            signed in and your account will be created and placed on the right
            team.
          </p>
          <SignOutControl className="button button--secondary" />
        </section>
      </main>
    );
  }

  return (
    <SimulatorApp
      authMode="managed"
      accountControls={
        <AccountControls
          name={state.user.name}
          initials={state.user.initials}
          isPlatformAdmin={state.user.role === "platform_admin"}
        />
      }
    />
  );
}
