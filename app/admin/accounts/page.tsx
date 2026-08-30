import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AccountsPanel } from "@/components/accounts-panel";
import {
  SESSION_COOKIE_NAME,
  canHostCompetitions,
  getSessionFromToken,
} from "@/lib";
import { isManagedAuthMode } from "@/lib/server/auth-mode";

export const dynamic = "force-dynamic";

export default async function AccountsPage() {
  if (isManagedAuthMode()) {
    const {
      getManagedSessionState,
      hasManagedMfaEnrolled,
      isAdminMfaRequired,
    } = await import("@/lib/server/managed-identity");

    const state = await getManagedSessionState();

    if (state.kind === "signed-out") {
      redirect("/sign-in");
    }

    if (state.kind !== "linked" || !canHostCompetitions(state.user.role)) {
      redirect("/");
    }

    if (isAdminMfaRequired() && !(await hasManagedMfaEnrolled(state.subject))) {
      redirect("/account?mfa=required");
    }

    return (
      <AccountsPanel
        managed
        canInviteAdmins={state.user.role === "platform_admin"}
      />
    );
  }

  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const user = token ? getSessionFromToken(token) : null;

  if (!user || !canHostCompetitions(user.role)) {
    redirect("/");
  }

  return (
    <AccountsPanel
      managed={false}
      canInviteAdmins={user.role === "platform_admin"}
    />
  );
}
