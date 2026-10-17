import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { WrappedStory } from "@/components/wrapped-story";
import { SESSION_COOKIE_NAME, getSessionFromToken } from "@/lib";
import { isManagedAuthMode } from "@/lib/server/auth-mode";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Wrapped · Luban Market Lab",
  description: "Your competition, wrapped.",
};

/** The end-of-competition story. Signed-in only; the stats come from /api/wrapped. */
export default async function WrappedPage() {
  if (isManagedAuthMode()) {
    const { getManagedSessionState } = await import("@/lib/server/managed-identity");
    const state = await getManagedSessionState();

    if (state.kind === "signed-out") {
      redirect(`/sign-in?redirect_url=${encodeURIComponent("/wrapped")}`);
    }
    // Suspended and unlinked sign-ins get the home page's explanation.
    if (state.kind !== "linked") redirect("/");
  } else {
    const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    // The home page starts a demo identity, as it does for any new visitor.
    if (!(token && (await getSessionFromToken(token)))) redirect("/");
  }

  return <WrappedStory />;
}
