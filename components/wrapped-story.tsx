"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { animate, AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { extractError, readJson } from "@/lib/api-client";
import type { WrappedAward, WrappedResponse } from "@/lib/contracts";

import { CloseIcon } from "./simulator-icons";
import styles from "./wrapped-story.module.css";

const money = new Intl.NumberFormat("en-CA", {
  style: "currency",
  currency: "CAD",
  maximumFractionDigits: 0,
});

const formatDollars = (cents: number) => money.format(cents / 100);
const formatSigned = (cents: number) =>
  `${cents >= 0 ? "+" : "−"}${money.format(Math.abs(cents) / 100)}`;
const formatPercent = (value: number) =>
  `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}%`;

type Load =
  | { kind: "loading" }
  | { kind: "not-published" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: WrappedResponse };

/** Counts up to `value` (instantly with reduced motion). */
function CountUp({
  value,
  format = (n) => Math.round(n).toLocaleString("en-CA"),
}: {
  value: number;
  format?: (n: number) => string;
}) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (reduced) {
      const timer = window.setTimeout(() => setShown(value), 0);
      return () => window.clearTimeout(timer);
    }
    const controls = animate(0, value, { duration: 1.2, ease: "easeOut", onUpdate: setShown });
    return () => controls.stop();
  }, [value, reduced]);
  return <>{format(shown)}</>;
}

type AwardSpec = {
  label: string;
  award: WrappedAward | null;
  /** The headline figure under the winner's name. */
  stat: (award: WrappedAward) => string;
};

const count = (unit: string) => (a: WrappedAward) => `${a.count ?? 0} ${unit}`;
const cents = (a: WrappedAward) => formatSigned(a.valueCents ?? 0);

/** One or two awards on a slide; null when none of them has a winner. */
function awardSlide(specs: AwardSpec[], title: string): ReactNode {
  const present = specs.filter((spec) => spec.award);
  if (present.length === 0) return null;
  return (
    <>
      <p className={styles.kicker}>{title}</p>
      <ul className={styles.awards}>
        {present.map(({ label, award, stat }) => (
          <li key={label} className={styles.award}>
            <span className={styles.awardLabel}>{label}</span>
            <strong className={styles.awardName}>{award!.name}</strong>
            {award!.teamName !== award!.name ? (
              <span className={styles.awardTeam}>{award!.teamName}</span>
            ) : null}
            <span className={styles.awardStat}>
              {stat(award!)}
              {award!.detail ? ` · ${award!.detail}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

type Slide = { id: string; tone: string; label: string; body: ReactNode };

function buildSlides({ summary, personal }: WrappedResponse): Slide[] {
  const a = summary.awards;
  const slides: Slide[] = [
    {
      id: "intro",
      tone: "purple",
      label: "Welcome",
      body: (
        <>
          <p className={styles.kicker}>{summary.competitionName}</p>
          <h2 className={styles.hero}>Your competition, wrapped.</h2>
          <p className={styles.lead}>Tap to see how it all went down.</p>
        </>
      ),
    },
    {
      id: "totals",
      tone: "ink",
      label: "Totals",
      body: (
        <>
          <p className={styles.kicker}>Everyone together made</p>
          <p className={styles.big}>
            <CountUp value={summary.totalTrades} />
          </p>
          <p className={styles.lead}>trades, moving</p>
          <p className={styles.big}>
            <CountUp value={summary.totalTradedCents / 100} format={(n) => money.format(n)} />
          </p>
          <p className={styles.lead}>of pretend money.</p>
        </>
      ),
    },
  ];

  if (summary.topSymbols.length > 0) {
    slides.push({
      id: "symbols",
      tone: "lime",
      label: "Top symbols",
      body: (
        <>
          <p className={styles.kicker}>The crowd favourites</p>
          <ol className={styles.rank}>
            {summary.topSymbols.slice(0, 5).map((item, index) => (
              <li key={item.symbol}>
                <span className={styles.rankNo}>{index + 1}</span>
                <strong>{item.symbol}</strong>
                <span>{formatDollars(item.tradedCents)} traded</span>
              </li>
            ))}
          </ol>
        </>
      ),
    });
  }

  const awardSlides: [id: string, tone: string, title: string, specs: AwardSpec[]][] = [
    [
      "team-volume",
      "pink",
      "Team awards: volume",
      [
        { label: "Most money traded", award: a.mostTraded, stat: (x) => formatDollars(x.valueCents ?? 0) },
        { label: "Most trades", award: a.mostTrades, stat: count("trades") },
      ],
    ],
    [
      "team-swings",
      "teal",
      "Team awards: gains and losses",
      [
        { label: "Biggest gain", award: a.biggestGain, stat: cents },
        { label: "Biggest loss", award: a.biggestLoss, stat: cents },
      ],
    ],
    [
      "team-style",
      "gold",
      "Team awards: style",
      [
        { label: "Biggest comeback", award: a.biggestComeback, stat: cents },
        { label: "Most diversified", award: a.mostDiversified, stat: count("different symbols") },
      ],
    ],
    [
      "member-skill",
      "purple",
      "Standout traders",
      [
        { label: "Top trader", award: a.topTrader, stat: (x) => `${formatDollars(x.valueCents ?? 0)} traded` },
        { label: "Best trade", award: a.bestTrade, stat: cents },
      ],
    ],
    [
      "member-hours",
      "ink",
      "Trading hours",
      [
        { label: "Night owl", award: a.nightOwl, stat: () => "Latest trade" },
        { label: "Early bird", award: a.earlyBird, stat: () => "Earliest trade" },
      ],
    ],
    [
      "member-rejected",
      "pink",
      "Better luck next time",
      [{ label: "Most rejected orders", award: a.mostRejected, stat: count("rejected orders") }],
    ],
  ];
  for (const [id, tone, title, specs] of awardSlides) {
    const body = awardSlide(specs, title);
    if (body) slides.push({ id, tone, label: title, body });
  }

  if (personal) {
    slides.push({
      id: "you",
      tone: "lime",
      label: "You",
      body: (
        <>
          <p className={styles.kicker}>You{personal.teamName ? `, on ${personal.teamName}` : ""}</p>
          <p className={styles.big}>
            <CountUp value={personal.tradeCount} />
          </p>
          <p className={styles.lead}>
            trades, {formatDollars(personal.tradedCents)} traded, {formatSigned(personal.realizedCents)} realized.
          </p>
          <ul className={styles.facts}>
            {personal.favoriteSymbol ? (
              <li>
                Favourite symbol: <strong>{personal.favoriteSymbol}</strong>
              </li>
            ) : null}
            {personal.bestTrade ? (
              <li>
                Best trade: <strong>{personal.bestTrade.symbol}</strong> (
                {formatSigned(personal.bestTrade.realizedCents)})
              </li>
            ) : null}
            <li>
              You traded more than <strong>{Math.round(personal.tradeCountPercentile)}%</strong> of
              traders.
            </li>
          </ul>
        </>
      ),
    });
  }

  slides.push(
    {
      id: "leaderboard",
      tone: "teal",
      label: "Final leaderboard",
      body: (
        <>
          <p className={styles.kicker}>The final leaderboard</p>
          <ol className={styles.rank}>
            {summary.teams.map((team) => (
              <li key={team.teamId}>
                <span className={styles.rankNo}>{team.rank}</span>
                <strong>{team.teamName}</strong>
                <span>{formatPercent(team.returnPercent)}</span>
              </li>
            ))}
          </ol>
        </>
      ),
    },
    {
      id: "outro",
      tone: "purple",
      label: "Thanks",
      body: (
        <>
          <h2 className={styles.hero}>That&apos;s a wrap.</h2>
          <p className={styles.lead}>Thanks for playing. See you at the next one.</p>
          <Link className={styles.outroLink} href="/">
            Back to the Market Lab
          </Link>
        </>
      ),
    },
  );
  return slides;
}

function StoryState({ title, text }: { title: string; text: string }) {
  return (
    <main className={styles.story} data-tone="purple">
      <div className={styles.stateBox}>
        <h1 className={styles.hero}>{title}</h1>
        <p className={styles.lead}>{text}</p>
        <Link className={styles.outroLink} href="/">
          Back to the Market Lab
        </Link>
      </div>
    </main>
  );
}

export function WrappedStory() {
  const router = useRouter();
  const reduced = useReducedMotion();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  // The direction lives with the index so the slide knows which way to enter.
  const [{ index, direction }, setPos] = useState({ index: 0, direction: 1 });

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const response = await fetch("/api/wrapped", {
          credentials: "same-origin",
          signal: controller.signal,
        });
        const payload = await readJson(response);
        if (response.ok) {
          setLoad({ kind: "ready", data: payload as WrappedResponse });
        } else if (
          (payload as { error?: { code?: string } }).error?.code === "WRAPPED_NOT_PUBLISHED"
        ) {
          setLoad({ kind: "not-published" });
        } else {
          setLoad({ kind: "error", message: extractError(payload, "Wrapped could not load.") });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setLoad({
          kind: "error",
          message: error instanceof Error ? error.message : "Wrapped could not load.",
        });
      }
    })();
    return () => controller.abort();
  }, []);

  const slides = load.kind === "ready" ? buildSlides(load.data) : [];
  const last = slides.length - 1;

  const go = useCallback(
    (step: 1 | -1) => {
      setPos((current) => ({
        index: Math.min(Math.max(current.index + step, 0), Math.max(last, 0)),
        direction: step,
      }));
    },
    [last],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") router.push("/");
      else if (event.key === "ArrowRight") go(1);
      else if (event.key === "ArrowLeft") go(-1);
      // Space on a focused button or link already activates it.
      else if (
        event.key === " " &&
        !(event.target instanceof HTMLButtonElement || event.target instanceof HTMLAnchorElement)
      ) {
        event.preventDefault();
        go(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, router]);

  if (load.kind === "loading") {
    return (
      <main className={styles.story} data-tone="purple" aria-busy="true">
        <p className={styles.lead} role="status">
          Loading your Wrapped…
        </p>
      </main>
    );
  }
  if (load.kind === "not-published") {
    return (
      <StoryState
        title="Wrapped isn't out yet."
        text="The host hasn't published it. Check back once the competition is over."
      />
    );
  }
  if (load.kind === "error") {
    return <StoryState title="Something went wrong." text={load.message} />;
  }

  const slide = slides[index];
  const shift = reduced ? 0 : 48 * direction;

  return (
    <main className={styles.story} data-tone={slide.tone} aria-label="Wrapped">
      <div className={styles.top}>
        <ol className={styles.bars} aria-hidden="true">
          {slides.map((item, i) => (
            <li key={item.id} className={styles.bar} data-done={i <= index || undefined} />
          ))}
        </ol>
        <button
          type="button"
          className={styles.close}
          aria-label="Close Wrapped"
          onClick={() => router.push("/")}
        >
          <CloseIcon />
        </button>
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.section
          key={slide.id}
          className={styles.slide}
          aria-label={`${index + 1} of ${slides.length}: ${slide.label}`}
          initial={{ opacity: 0, x: shift }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -shift }}
          transition={{ duration: reduced ? 0.15 : 0.3 }}
        >
          {slide.body}
        </motion.section>
      </AnimatePresence>

      <p className="sr-only" aria-live="polite">
        Slide {index + 1} of {slides.length}: {slide.label}
      </p>

      <button
        type="button"
        className={`${styles.zone} ${styles.zonePrev}`}
        aria-label="Previous slide"
        onClick={() => go(-1)}
        disabled={index === 0}
      />
      <button
        type="button"
        className={`${styles.zone} ${styles.zoneNext}`}
        aria-label="Next slide"
        onClick={() => go(1)}
        disabled={index === last}
      />
    </main>
  );
}
