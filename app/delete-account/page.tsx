import type { Metadata } from "next";
import Link from "next/link";

import { AccountDeletionFacts } from "@/components/account-deletion-facts";
import { isManagedAuthMode } from "@/lib/server/auth-mode";

import styles from "./delete-account.module.css";

export const metadata: Metadata = {
  title: "Delete your account · Luban Market Lab",
  description:
    "How to delete your Luban Market Lab account, what is deleted, and what is kept.",
};

// TODO(owner): replace with a dedicated deletion-request address or form
// once one exists. Until then requests go through the public site's contact
// options. Do not put an unverified email address here.
const CONTACT_URL = "https://lubancanada.com";

/**
 * Public account-deletion page, and where the app lands after a deletion
 * (?deleted=1). Needs no sign-in and reads nothing private.
 */
export default async function DeleteAccountPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const justDeleted = params.deleted === "1";

  return (
    <main className="accounts-page">
      <div className="accounts-sheet accounts-sheet--narrow">
        <header className="accounts-header">
          <div>
            <p className="route-state__brand">Luban Market Lab</p>
            <h1>{justDeleted ? "Account deleted" : "Delete your account"}</h1>
          </div>
          <Link className="button button--secondary" href="/">
            {justDeleted ? "Go to sign in" : "Back to the Market Lab"}
          </Link>
        </header>

        <div className={styles.body}>
          {justDeleted ? (
            <p className={styles.done} role="status">
              Your Luban Market Lab account and sign-in have been deleted and
              you&apos;ve been signed out. Thanks for trading with us.
            </p>
          ) : null}

          <section aria-labelledby="delete-in-app">
            <h2 id="delete-in-app">Delete your account in the app</h2>
            {isManagedAuthMode() ? null : (
              <p className={styles.note}>
                This copy of the Market Lab runs on demo identities, which are
                shared samples and can&apos;t be deleted.
              </p>
            )}
            <ol>
              <li>
                Sign in to the Luban Market Lab app, or at{" "}
                <a href="https://sim.lubancanada.com">sim.lubancanada.com</a>.
              </li>
              <li>
                Open the menu under your name at the top of the screen and
                choose <strong>Account</strong>.
              </li>
              <li>
                Under <strong>Delete account</strong>, choose{" "}
                <strong>Delete account…</strong>, read what will be removed,
                type <strong>DELETE</strong>, and confirm.
              </li>
            </ol>
            <p>
              Deletion happens straight away and signs you out on every
              device. It can&apos;t be undone; to come back, you&apos;ll need a
              new invitation from your competition host.
            </p>
          </section>

          <section aria-labelledby="delete-what">
            <h2 id="delete-what">What is deleted and what is kept</h2>
            <AccountDeletionFacts className={styles.facts} />
            {/* TODO(owner): state how long database backups are kept (for
                example "up to 7 days") once the hosting plan's backup
                retention is confirmed. */}
            <p>
              Deleted data is removed from the live service immediately.
              Copies in our database backups are removed as those backups
              expire. What is kept stays with your team&apos;s competition
              records for as long as those records are kept.
            </p>
          </section>

          <section aria-labelledby="delete-help">
            <h2 id="delete-help">Can&apos;t sign in?</h2>
            <p>
              Ask your competition host to delete your account for you, or
              contact Luban through{" "}
              <a href={CONTACT_URL}>lubancanada.com</a> with the email address
              you signed up with and ask for your Market Lab account to be
              deleted. We&apos;ll confirm the request with that address before
              deleting anything.
            </p>
            <p>
              Still signed in but stuck? <Link href="/feedback">Send us feedback</Link>{" "}
              from the app and we&apos;ll help.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
