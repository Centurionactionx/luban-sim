import type { Metadata } from "next";
import Link from "next/link";

import {
  CHANGE_KIND_LABELS,
  CHANGELOG,
  type ChangeKind,
  type ChangelogRelease,
} from "@/lib/changelog";

export const metadata: Metadata = {
  title: "What's new · Luban Market Lab",
  description: "What's changed in each release of the Luban Market Lab.",
};

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "";
const KIND_ORDER = Object.keys(CHANGE_KIND_LABELS) as ChangeKind[];

function formatReleaseDate(date: string): string {
  // Dates are calendar days; noon UTC keeps them on the same day everywhere.
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}

function releaseId(release: ChangelogRelease): string {
  return release.version
    ? `release-${release.version.toLowerCase().replace(/\./g, "-")}`
    : `release-${release.date}`;
}

/** Every release's changes, newest first. Public: it holds nothing private. */
export default function ChangelogPage() {
  return (
    <main className="accounts-page">
      <div className="accounts-sheet changelog">
        <header className="accounts-header">
          <div>
            <p className="route-state__brand">Luban Market Lab</p>
            <h1>What&apos;s new</h1>
          </div>
          <Link className="button button--secondary" href="/">
            Back to the Market Lab
          </Link>
        </header>
        <p className="changelog__intro">
          Everything we&apos;ve changed in the simulator, newest first.
          {APP_VERSION ? (
            <>
              {" "}
              You&apos;re on <strong>v{APP_VERSION}</strong>.
            </>
          ) : null}{" "}
          The earliest releases didn&apos;t have numbers, so they&apos;re listed by date.
        </p>

        <ol className="changelog__releases">
          {CHANGELOG.map((release) => {
            const id = releaseId(release);
            const isCurrent = release.version !== null && release.version === APP_VERSION;
            return (
              <li key={id} className="changelog-release" aria-labelledby={`${id}-title`}>
                <div className="changelog-release__meta">
                  {release.version === "Unreleased" ? (
                    <span className="changelog-release__version changelog-release__version--next">
                      Coming next
                    </span>
                  ) : release.version ? (
                    <span className="changelog-release__version">v{release.version}</span>
                  ) : null}
                  {release.date ? (
                    <time dateTime={release.date}>{formatReleaseDate(release.date)}</time>
                  ) : null}
                  {isCurrent ? <span className="changelog-release__current">Your version</span> : null}
                </div>
                <h2 id={`${id}-title`}>{release.title}</h2>
                {KIND_ORDER.map((kind) => {
                  const entries = release.changes.filter((change) => change.kind === kind);
                  if (entries.length === 0) return null;
                  return (
                    <section key={kind} className="changelog-release__group">
                      <h3 className={`changelog-kind changelog-kind--${kind}`}>
                        {CHANGE_KIND_LABELS[kind]}
                      </h3>
                      <ul>
                        {entries.map((entry) => (
                          <li key={entry.text}>{entry.text}</li>
                        ))}
                      </ul>
                    </section>
                  );
                })}
              </li>
            );
          })}
        </ol>
      </div>
    </main>
  );
}
