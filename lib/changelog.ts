/**
 * What changed in each release, newest first, written from the git history.
 * The in-app "What's new" page and CHANGELOG.md (`pnpm changelog`) are both
 * built from this list; a unit test keeps the markdown file in step.
 *
 * Releases before v1.28.0 were not numbered, so that history is grouped by
 * date. Commits marked "local, unreleased" are folded into the release that
 * shipped them.
 */

export type ChangeKind = "added" | "changed" | "fixed" | "security";

export interface ChangelogEntry {
  kind: ChangeKind;
  text: string;
}

export interface ChangelogRelease {
  /** "Unreleased", a semantic version like "1.35.1", or null for early, unnumbered work. */
  version: string | null;
  /** YYYY-MM-DD; null while unreleased. */
  date: string | null;
  title: string;
  changes: ChangelogEntry[];
}

export const CHANGE_KIND_LABELS: Record<ChangeKind, string> = {
  added: "New",
  changed: "Improved",
  fixed: "Fixed",
  security: "Security",
};

export const CHANGELOG: readonly ChangelogRelease[] = [
  {
    version: "1.36.0",
    date: "2026-10-05",
    title: "Team watchlists and trade history",
    changes: [
      { kind: "added", text: "Team watchlist. Press Watch beside a quote's price to add it. Your whole team shares one list of up to 20 symbols, and each row has a small chart of today's price. Sort it by symbol, price or the day's move." },
      { kind: "added", text: "A trade history panel. It shows who placed each trade and what every sale made or lost, and can load your last 100 trades." },
      { kind: "added", text: "Holdings now show what you paid per share on average. The portfolio splits its gain into unrealized (shares you still hold) and realized (shares you've sold)." },
      { kind: "added", text: "Download your holdings or your full trade history as a CSV file." },
      { kind: "added", text: "A dark theme. It matches your device until you flip it with the sun/moon button in the header, and it remembers your pick." },
      { kind: "added", text: "Platform admins can reset their private test portfolio back to the cash they funded it with." },
      { kind: "added", text: "A Feedback button in the header, and a /feedback page, for telling us what's working and what isn't on the website or in the simulator. Platform admins read it all in one list." },
      { kind: "added", text: "This What's new page. Click the version number in the footer to get here." },
      { kind: "fixed", text: "The Sell button's label used to vanish when you hovered over it." },
      { kind: "fixed", text: "Two trades filled in the same instant could show up in the wrong order." },
    ],
  },
  {
    version: "1.35.1",
    date: "2026-10-05",
    title: "Mobile fixes",
    changes: [
      { kind: "fixed", text: "On phones, the Advanced view header now wraps so its close button stays on screen. The price readout wraps too instead of getting cut off." },
      { kind: "fixed", text: "Hovering or tapping the cash area on the portfolio map no longer pulls it on top of your holdings." },
    ],
  },
  {
    version: "1.35.0",
    date: "2026-10-05",
    title: "Activity bell and How to use link",
    changes: [
      { kind: "added", text: "Team activity lives in a bell in the header now. A red bubble counts what you haven't seen yet." },
      { kind: "added", text: "A How to use link to the beginner's guide on lubancanada.com." },
      { kind: "changed", text: "The portfolio's update counter explains what it's counting." },
    ],
  },
  {
    version: "1.34.0",
    date: "2026-10-04",
    title: "Advanced charts and the portfolio map",
    changes: [
      { kind: "added", text: "Advanced chart view. Switch between line, candle and bar styles, pick your own date range and bar size, and read open, high, low, close and volume for any bar." },
      { kind: "added", text: "Portfolio map: a treemap of your holdings grouped by sector and industry, coloured by total return or by today's move. Hosts and admins can open any team's map from the leaderboard." },
      { kind: "changed", text: "Charts got proper price and time axes and volume bars, plus lines marking the current price and yesterday's close." },
      { kind: "changed", text: "Max and All now ask before filling in the ticket. The 1W portfolio history range is called 7D." },
    ],
  },
  {
    version: "1.33.0",
    date: "2026-10-04",
    title: "Detached dashboard tiles",
    changes: [
      { kind: "changed", text: "Each part of the dashboard now sits on the purple background as its own card, with the quote workbench in the middle." },
    ],
  },
  {
    version: "1.32.0",
    date: "2026-10-04",
    title: "Live quote before a waiting order",
    changes: [
      { kind: "fixed", text: "Limit, stop loss and take profit orders sometimes got refused as \"paused\" right after a server started up. They now fetch a live price before placing." },
    ],
  },
  {
    version: "1.31.0",
    date: "2026-10-04",
    title: "Limit, stop loss and take profit orders",
    changes: [
      { kind: "added", text: "Limit, stop loss and take profit orders. They wait for your price and last for the day or until you cancel them." },
      { kind: "added", text: "Exits on a buy. Attach a take profit and a stop loss, and whichever fills first cancels the other." },
      { kind: "added", text: "A Waiting orders panel. Anyone on the team can see and cancel the team's orders there." },
      { kind: "added", text: "Prices get checked every minute, and each order that hits its price fills exactly once." },
      { kind: "changed", text: "Cash and shares tied up in waiting orders are set aside, so they don't count toward buying power." },
    ],
  },
  {
    version: "1.30.0",
    date: "2026-10-03",
    title: "Groundwork for waiting orders",
    changes: [
      { kind: "added", text: "Behind-the-scenes work for limit, stop loss and take profit orders. Nothing visible in the app yet." },
    ],
  },
  {
    version: "1.29.0",
    date: "2026-10-03",
    title: "Full version in the footer",
    changes: [
      { kind: "changed", text: "The footer shows the full version number and links to the maker's profiles." },
    ],
  },
  {
    version: "1.28.0",
    date: "2026-10-03",
    title: "Release number in the footer",
    changes: [
      { kind: "added", text: "The footer shows which release you're on and who built the simulator." },
    ],
  },
  {
    version: null,
    date: "2026-10-03",
    title: "Crypto, ETFs and quicker search",
    changes: [
      { kind: "added", text: "ETFs and crypto, each switched on separately. Crypto trades around the clock in fixed lots. Leveraged and inverse funds aren't allowed." },
      { kind: "added", text: "Suggestions show up under the search box as you type, starting with listings the page already knows about." },
      { kind: "added", text: "Click the empty search box to see popular picks, like what the competition traded most and the day's busiest stocks." },
      { kind: "added", text: "Max / All fills in the biggest quantity you can afford or hold. Press / anywhere to jump to the search box." },
      { kind: "changed", text: "When the order button is greyed out, it tells you why: the market's closed, the competition isn't running, your team is frozen, or you're short on cash or shares." },
      { kind: "changed", text: "Search prefers CAD crypto pairs and opens the best match, so typing btc gets you Bitcoin." },
      { kind: "changed", text: "The portfolio value chart works for real teams now and its range buttons actually filter. The big number at the top is cash plus holdings, the same figure the leaderboard uses." },
      { kind: "fixed", text: "Times all show in Eastern time. Before, the page could error on load when your computer and the server were in different time zones." },
      { kind: "fixed", text: "If market data goes down, holdings keep their last known price instead of breaking the dashboard." },
      { kind: "fixed", text: "The chart's hover box sits next to the bar you're pointing at instead of on top of it." },
    ],
  },
  {
    version: null,
    date: "2026-10-02",
    title: "Database keep-alive",
    changes: [
      { kind: "added", text: "A daily job pings the hosted database so it doesn't go to sleep." },
    ],
  },
  {
    version: null,
    date: "2026-09-24",
    title: "Trading integrity and rules links",
    changes: [
      { kind: "changed", text: "Competition orders only go through during the exchange's regular hours and on a recent price. You can't trade after-hours news at yesterday's prices." },
      { kind: "changed", text: "The sign-in, sign-up and invitation pages link to the contest rules and the privacy policy." },
      { kind: "security", text: "If a host is removed or loses their role, their unused invitations stop working. Every invitation also re-checks who sent it when someone accepts it." },
      { kind: "security", text: "A team whose books don't balance no longer stops trading for everyone else. Server error details stay in the server log." },
    ],
  },
  {
    version: null,
    date: "2026-09-12",
    title: "Team management",
    changes: [
      { kind: "added", text: "Hosts can add, rename and remove teams from a compact set of team controls." },
    ],
  },
  {
    version: null,
    date: "2026-09-01",
    title: "Admin test portfolios",
    changes: [
      { kind: "added", text: "Platform admins get a private test portfolio with its own cash. It trades like a team but never shows up on the leaderboard." },
    ],
  },
  {
    version: null,
    date: "2026-08-30",
    title: "Real sign-in and competition schedules",
    changes: [
      { kind: "added", text: "Real accounts. You can only sign up with an invitation, and every account is a student, host or admin. Sign-ins and account changes go in an audit log." },
      { kind: "added", text: "Competition schedules. Hosts set the start, the end and the starting cash, and trading opens and closes on its own." },
      { kind: "added", text: "Hosts and admins can suspend accounts, change roles, move people between teams and delete accounts." },
      { kind: "added", text: "PostgreSQL support next to the local SQLite database, plus a health check endpoint." },
      { kind: "added", text: "The Past → Present valuation lab for admins." },
      { kind: "security", text: "Limits on how fast anyone can place orders, send invitations or reload the dashboard, along with fixes from a full security review." },
    ],
  },
  {
    version: null,
    date: "2026-08-29",
    title: "First prototype",
    changes: [
      { kind: "added", text: "The shared team trading room. A team portfolio, quotes and charts from real market data, market orders and the competition leaderboard." },
    ],
  },
];

function releaseHeading(release: ChangelogRelease): string {
  if (release.version === "Unreleased") return `Unreleased: ${release.title}`;
  const date = release.date ?? "";
  return release.version
    ? `v${release.version}: ${release.title} (${date})`
    : `${date}: ${release.title}`;
}

/** CHANGELOG.md's exact contents. Regenerate the file with `pnpm changelog`. */
export function renderChangelogMarkdown(releases: readonly ChangelogRelease[] = CHANGELOG): string {
  const lines = [
    "# Changelog",
    "",
    "What's changed in each release of the Luban Market Lab, newest first.",
    "Releases before v1.28.0 didn't have numbers, so they're listed by date.",
    "",
    "<!-- Generated from lib/changelog.ts by `pnpm changelog`. Edit that file, not this one. -->",
  ];

  for (const release of releases) {
    lines.push("", `## ${releaseHeading(release)}`);
    for (const kind of Object.keys(CHANGE_KIND_LABELS) as ChangeKind[]) {
      const entries = release.changes.filter((change) => change.kind === kind);
      if (entries.length === 0) continue;
      lines.push("", `### ${CHANGE_KIND_LABELS[kind]}`, "");
      for (const entry of entries) lines.push(`- ${entry.text}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
