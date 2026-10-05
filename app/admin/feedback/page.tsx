import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  MAX_FEEDBACK_LIST_LIMIT,
  SESSION_COOKIE_NAME,
  getSessionFromToken,
  listFeedback,
  type FeedbackItem,
  type FeedbackSource,
  type FeedbackTopic,
} from "@/lib";
import { isManagedAuthMode } from "@/lib/server/auth-mode";
import { DISPLAY_TIME_ZONE } from "@/lib/time";

export const dynamic = "force-dynamic";

const FILTERS: Array<{ label: string; topic: FeedbackTopic | null; href: string }> = [
  { label: "All", topic: null, href: "/admin/feedback" },
  { label: "Website", topic: "WEBSITE", href: "/admin/feedback?topic=website" },
  { label: "Simulator", topic: "SIMULATOR", href: "/admin/feedback?topic=simulator" },
];

const TOPIC_LABELS: Record<FeedbackTopic, string> = {
  WEBSITE: "Website",
  SIMULATOR: "Simulator",
};

const SOURCE_LABELS: Record<FeedbackSource, string> = {
  header: "Header button",
  page: "Feedback page",
};

function formatSentAt(iso: string): string {
  return `${new Date(iso).toLocaleString("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: DISPLAY_TIME_ZONE,
  })} ET`;
}

/** Signed-in platform administrator, or a redirect away (as the other admin pages do). */
async function requireAdminId(): Promise<string> {
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

    if (state.kind !== "linked" || state.user.role !== "platform_admin") {
      redirect("/");
    }

    if (isAdminMfaRequired() && !(await hasManagedMfaEnrolled(state.subject))) {
      redirect("/account?mfa=required");
    }

    return state.user.id;
  }

  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const user = token ? await getSessionFromToken(token) : null;

  if (!user || user.role !== "platform_admin") {
    redirect("/");
  }

  return user.id;
}

function FeedbackEntry({ item }: { item: FeedbackItem }) {
  return (
    <li className="feedback-entry">
      <div className="feedback-entry__meta">
        <time dateTime={item.createdAt}>{formatSentAt(item.createdAt)}</time>
        <span className={`feedback-tag feedback-tag--${item.topic.toLowerCase()}`}>
          {TOPIC_LABELS[item.topic]}
        </span>
        <span>
          <strong>{item.userName}</strong>{" "}
          <a href={`mailto:${item.userEmail}`}>{item.userEmail}</a>
        </span>
        <span>{item.teamName ?? "No team"}</span>
        <span>{SOURCE_LABELS[item.source]}</span>
      </div>
      <p className="feedback-entry__message">{item.message}</p>
    </li>
  );
}

export default async function AdminFeedbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const adminId = await requireAdminId();
  const params = await searchParams;
  const requested = typeof params.topic === "string" ? params.topic.toUpperCase() : "";
  const active = FILTERS.find((filter) => filter.topic === requested) ?? FILTERS[0];
  const items = await listFeedback(adminId, {
    topic: active.topic ?? undefined,
    limit: MAX_FEEDBACK_LIST_LIMIT,
  });

  return (
    <main className="accounts-page">
      <div className="accounts-sheet">
        <header className="accounts-header">
          <div>
            <p className="route-state__brand">Luban Market Lab</p>
            <h1>User feedback</h1>
          </div>
          <Link className="button button--secondary" href="/">
            Back to the Market Lab
          </Link>
        </header>

        <section className="accounts-list" aria-labelledby="feedback-heading">
          <h2 id="feedback-heading">Newest first</h2>
          <nav className="feedback-filter" aria-label="Filter feedback by topic">
            {FILTERS.map((filter) => (
              <Link
                key={filter.label}
                href={filter.href}
                aria-current={filter === active ? "page" : undefined}
              >
                {filter.label}
              </Link>
            ))}
          </nav>

          {items.length === 0 ? (
            <p className="feedback-empty">
              {active.topic
                ? `No ${TOPIC_LABELS[active.topic].toLowerCase()} feedback yet.`
                : "No feedback yet. Anything people send from the Feedback button or the /feedback page shows up here."}
            </p>
          ) : (
            <>
              <p className="feedback-count">
                {items.length === MAX_FEEDBACK_LIST_LIMIT
                  ? `Showing the newest ${MAX_FEEDBACK_LIST_LIMIT} messages`
                  : `${items.length} ${items.length === 1 ? "message" : "messages"}`}
              </p>
              <ol className="feedback-list">
                {items.map((item) => (
                  <FeedbackEntry key={item.id} item={item} />
                ))}
              </ol>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
