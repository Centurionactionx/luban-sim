import Link from "next/link";

import type { InvitationPreview } from "@/lib/contracts";
import { DISPLAY_TIME_ZONE } from "@/lib/time";
import { previewInvitation } from "@/lib/server/invitations";
import { isManagedAuthMode } from "@/lib/server/auth-mode";
import { JoinAcceptPanel } from "@/components/join-accept";
import { LegalNote } from "@/components/legal-note";

export const dynamic = "force-dynamic";

function roleLabel(role: InvitationPreview["role"]): string {
  if (role === "student") return "student";
  if (role === "host") return "competition host";
  return "platform administrator";
}

function InvitationFacts({ preview }: { preview: InvitationPreview }) {
  return (
    <dl className="invitation-facts">
      <div>
        <dt>Joining as</dt>
        <dd>{roleLabel(preview.role)}</dd>
      </div>
      {preview.teamName ? (
        <div>
          <dt>Team</dt>
          <dd>{preview.teamName}</dd>
        </div>
      ) : null}
      {preview.competitionName ? (
        <div>
          <dt>Competition</dt>
          <dd>{preview.competitionName}</dd>
        </div>
      ) : null}
      {preview.maskedEmail ? (
        <div>
          <dt>Issued to</dt>
          <dd>{preview.maskedEmail}</dd>
        </div>
      ) : null}
      <div>
        <dt>Expires</dt>
        <dd>
          {new Date(preview.expiresAt).toLocaleString("en-CA", {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: DISPLAY_TIME_ZONE,
          })}{" "}
          ET
        </dd>
      </div>
    </dl>
  );
}

function StateSheet({
  title,
  children,
  titleId,
}: {
  title: string;
  children: React.ReactNode;
  titleId: string;
}) {
  return (
    <main className="route-state" aria-labelledby={titleId}>
      <section className="route-state__sheet">
        <p className="route-state__brand">Luban Market Lab</p>
        <h1 id={titleId}>{title}</h1>
        {children}
        <LegalNote />
      </section>
    </main>
  );
}

export default async function JoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  if (!isManagedAuthMode()) {
    return (
      <StateSheet
        titleId="join-demo-title"
        title="Invitations need the managed deployment."
      >
        <p>
          This environment runs in demo mode, so invitation links cannot be
          redeemed here. Ask your host for the address of the real
          competition deployment.
        </p>
        <Link className="button button--primary" href="/">
          Open the demo trading room
        </Link>
      </StateSheet>
    );
  }

  const preview = await previewInvitation(token);

  if (!preview) {
    return (
      <StateSheet titleId="join-invalid-title" title="This invitation link is not valid.">
        <p>
          The link may have been copied incompletely. Ask your competition
          host to send the invitation again.
        </p>
      </StateSheet>
    );
  }

  if (preview.state === "used") {
    return (
      <StateSheet titleId="join-used-title" title="This invitation was already used.">
        <p>
          Each invitation works exactly once. If you registered with it, sign
          in instead. If someone else used it, tell your competition host so
          they can investigate and issue a new one.
        </p>
        <Link className="button button--primary" href="/sign-in">
          Sign in
        </Link>
      </StateSheet>
    );
  }

  if (preview.state === "revoked" || preview.state === "expired") {
    return (
      <StateSheet
        titleId="join-stale-title"
        title={
          preview.state === "revoked"
            ? "This invitation was revoked."
            : "This invitation has expired."
        }
      >
        <p>Ask your competition host for a fresh invitation link.</p>
      </StateSheet>
    );
  }

  const { getManagedSessionState } = await import(
    "@/lib/server/managed-identity"
  );
  const state = await getManagedSessionState();

  if (state.kind === "linked") {
    return (
      <StateSheet titleId="join-linked-title" title="You already have an account.">
        <p>
          You are signed in as {state.user.name}, which is already linked to a
          Luban account. This invitation stays unused — hand it back to your
          host if it is not meant for you.
        </p>
        <Link className="button button--primary" href="/">
          Open the trading room
        </Link>
      </StateSheet>
    );
  }

  if (state.kind === "suspended") {
    return (
      <StateSheet titleId="join-suspended-title" title="This account is suspended.">
        <p>
          Your sign-in is linked to a suspended account, so the invitation
          cannot be accepted. Contact your competition host.
        </p>
      </StateSheet>
    );
  }

  if (state.kind === "signed-out") {
    const redirectTarget = encodeURIComponent(`/join/${token}`);

    return (
      <main className="route-state" aria-labelledby="join-welcome-title">
        <section className="route-state__sheet">
          <p className="route-state__brand">Luban Market Lab</p>
          <h1 id="join-welcome-title">You&apos;re invited.</h1>
          <InvitationFacts preview={preview} />
          <p>
            Create an account (or sign in) with the invited email address,
            verify it, and you will return here to take your seat.
          </p>
          <div className="route-state__actions">
            <a
              className="button button--primary"
              href={`/sign-up?redirect_url=${redirectTarget}`}
            >
              Create your account
            </a>
            <a
              className="button button--secondary"
              href={`/sign-in?redirect_url=${redirectTarget}`}
            >
              I already have a sign-in
            </a>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="route-state" aria-labelledby="join-accept-title">
      <section className="route-state__sheet">
        <p className="route-state__brand">Luban Market Lab</p>
        <h1 id="join-accept-title">Take your seat.</h1>
        <InvitationFacts preview={preview} />
        <JoinAcceptPanel token={token} teamName={preview.teamName} />
      </section>
    </main>
  );
}
