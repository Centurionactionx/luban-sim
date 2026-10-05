import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { FeedbackForm } from "@/components/feedback-form";
import {
  SESSION_COOKIE_NAME,
  getSessionFromToken,
  type FeedbackTopic,
  type SessionUser,
} from "@/lib";
import { isManagedAuthMode } from "@/lib/server/auth-mode";

export const dynamic = "force-dynamic";

/**
 * The feedback form on its own page, for the public website to link to
 * (`/feedback?topic=website` starts on Website). Signed-out visitors sign in
 * first and come straight back here.
 */
export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const initialTopic: FeedbackTopic =
    typeof params.topic === "string" && params.topic.toLowerCase() === "website"
      ? "WEBSITE"
      : "SIMULATOR";
  const returnTo = initialTopic === "WEBSITE" ? "/feedback?topic=website" : "/feedback";

  let user: SessionUser;

  if (isManagedAuthMode()) {
    const { getManagedSessionState } = await import(
      "@/lib/server/managed-identity"
    );
    const state = await getManagedSessionState();

    if (state.kind === "signed-out") {
      redirect(`/sign-in?redirect_url=${encodeURIComponent(returnTo)}`);
    }

    // Suspended and unlinked sign-ins get the home page's explanation.
    if (state.kind !== "linked") {
      redirect("/");
    }

    user = state.user;
  } else {
    const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
    const sessionUser = token ? await getSessionFromToken(token) : null;

    // The home page starts a demo identity, as it does for any new visitor.
    if (!sessionUser) {
      redirect("/");
    }

    user = sessionUser;
  }

  return (
    <main className="accounts-page">
      <div className="accounts-sheet accounts-sheet--narrow">
        <header className="accounts-header">
          <div>
            <p className="route-state__brand">Luban Market Lab</p>
            <h1>Send feedback</h1>
          </div>
          <Link className="button button--secondary" href="/">
            Back to the Market Lab
          </Link>
        </header>
        <section className="feedback-page__body" aria-label="Feedback form">
          <p className="feedback-page__intro">
            Tell us what works and what doesn&apos;t, on the Luban website or in
            this simulator. Sending as <strong>{user.name}</strong>
            {user.teamName ? (
              <>
                {" "}
                on <strong>{user.teamName}</strong>
              </>
            ) : null}
            .
          </p>
          <FeedbackForm source="page" initialTopic={initialTopic} />
        </section>
      </div>
    </main>
  );
}
