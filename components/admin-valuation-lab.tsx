"use client";

import Link from "next/link";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { extractError, readJson } from "@/lib/api-client";
import styles from "@/app/admin/valuation-lab/valuation-lab.module.css";
import type {
  AdminValuationPortfolio,
  AdminValuationPosition,
} from "@/lib/backtest-contracts";

const REFRESH_INTERVAL_MS = 60_000;
const TORONTO_TIME_ZONE = "America/Toronto";
const MAX_TEST_CASH_CENTS = 100_000_000_000_000;

type Feedback = {
  kind: "error" | "success";
  message: string;
};

const cadCurrency = new Intl.NumberFormat("en-CA", {
  style: "currency",
  currency: "CAD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const quantityNumber = new Intl.NumberFormat("en-CA", {
  maximumFractionDigits: 6,
});

const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  dateStyle: "medium",
  timeZone: "UTC",
});

const dateTimeFormatter = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: TORONTO_TIME_ZONE,
  timeZoneName: "short",
});

function isPortfolio(payload: unknown): payload is AdminValuationPortfolio {
  if (!payload || typeof payload !== "object") return false;
  const candidate = payload as Partial<AdminValuationPortfolio>;
  return Boolean(
    candidate.summary &&
      typeof candidate.summary.totalValueCents === "number" &&
      typeof candidate.summary.availableCashCents === "number" &&
      Array.isArray(candidate.positions),
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function money(cents: number): string {
  return cadCurrency.format(cents / 100);
}

function nativeMoney(cents: number, currency: "CAD" | "USD"): string {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function signedMoney(cents: number): string {
  if (cents === 0) return money(0);
  return `${cents > 0 ? "+" : "−"}${money(Math.abs(cents))}`;
}

function signedPercent(value: number): string {
  if (value === 0) return "0.00%";
  return `${value > 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}%`;
}

function calendarDate(value: string): string {
  return dateFormatter.format(new Date(`${value}T12:00:00.000Z`));
}

function dateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unavailable" : dateTimeFormatter.format(date);
}

function sourceLabel(source: AdminValuationPosition["source"]): string {
  return source === "YAHOO_FINANCE" ? "Yahoo Finance" : "Luban simulated";
}

function makeIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") {
    return `valuation:${crypto.randomUUID()}`;
  }

  return `valuation:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function toneClass(value: number): string {
  if (value > 0) return styles.positive;
  if (value < 0) return styles.negative;
  return styles.neutral;
}

function parseCashCents(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;

  const [dollars, fractional = ""] = normalized.split(".");
  const cents = Number(dollars) * 100 + Number(fractional.padEnd(2, "0"));

  return Number.isSafeInteger(cents) && cents <= MAX_TEST_CASH_CENTS
    ? cents
    : null;
}

function PricePair({
  nativeCents,
  cadCents,
  currency,
}: {
  nativeCents: number;
  cadCents: number;
  currency: "CAD" | "USD";
}) {
  return (
    <span className={styles.pricePair}>
      <strong>{nativeMoney(nativeCents, currency)}</strong>
      {currency === "USD" ? <small>{money(cadCents)} CAD equivalent</small> : null}
    </span>
  );
}

export function AdminValuationLab({
  defaultPurchaseDate,
  maxPurchaseDate,
}: {
  defaultPurchaseDate: string;
  maxPurchaseDate: string;
}) {
  const [portfolio, setPortfolio] = useState<AdminValuationPortfolio | null>(
    null,
  );
  const [symbol, setSymbol] = useState("");
  const [quantity, setQuantity] = useState("10");
  const [purchaseDate, setPurchaseDate] = useState(defaultPurchaseDate);
  const [cashDraft, setCashDraft] = useState<string | null>(null);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUpdatingCash, setIsUpdatingCash] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [clearArmed, setClearArmed] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [cashFeedback, setCashFeedback] = useState<Feedback | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  const refreshAbort = useRef<AbortController | null>(null);
  const mutationInFlight = useRef(false);
  const pendingIdempotencyKey = useRef<string | null>(null);
  const clearTrigger = useRef<HTMLButtonElement | null>(null);
  const clearConfirmation = useRef<HTMLButtonElement | null>(null);
  const clearHeadingId = useId();
  const formHelpId = useId();
  const cashInputId = useId();
  const cashHelpId = useId();
  const cashValidationId = useId();

  const applyPortfolio = useCallback((next: AdminValuationPortfolio) => {
    setPortfolio(next);
    setLastCheckedAt(new Date().toISOString());
  }, []);

  const loadPortfolio = useCallback(
    async (mode: "initial" | "manual" | "background") => {
      refreshAbort.current?.abort();
      const controller = new AbortController();
      refreshAbort.current = controller;

      if (mode === "initial") setIsInitialLoading(true);
      if (mode !== "initial") setIsRefreshing(true);
      if (mode === "manual") setFeedback(null);

      try {
        const response = await fetch("/api/admin/valuation-lab", {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        const payload = await readJson(response);

        if (!response.ok) {
          throw new Error(
            extractError(payload, "The valuation lab could not be refreshed."),
          );
        }
        if (!isPortfolio(payload)) {
          throw new Error("The valuation lab returned an unexpected response.");
        }

        applyPortfolio(payload);
        if (mode === "manual") {
          setFeedback({ kind: "success", message: "Valuations are up to date." });
        }
      } catch (error) {
        if (isAbortError(error)) return;
        setFeedback({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "The valuation lab could not be refreshed.",
        });
      } finally {
        if (refreshAbort.current === controller) {
          refreshAbort.current = null;
          setIsInitialLoading(false);
          setIsRefreshing(false);
        }
      }
    },
    [applyPortfolio],
  );

  useEffect(() => {
    let loadedAt = 0;
    // Hidden tabs sit out; coming back refreshes if a minute has passed. The
    // 1 s of slack lets a tick that lands just short of a full interval count.
    const refreshIfDue = () => {
      if (
        document.hidden ||
        mutationInFlight.current ||
        Date.now() - loadedAt < REFRESH_INTERVAL_MS - 1_000
      ) {
        return;
      }
      loadedAt = Date.now();
      void loadPortfolio("background");
    };
    const initialTimer = window.setTimeout(() => {
      loadedAt = Date.now();
      void loadPortfolio("initial");
    }, 0);
    const refreshTimer = window.setInterval(refreshIfDue, REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", refreshIfDue);

    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(refreshTimer);
      document.removeEventListener("visibilitychange", refreshIfDue);
      refreshAbort.current?.abort();
    };
  }, [loadPortfolio]);

  useEffect(() => {
    if (!clearArmed) return;
    clearConfirmation.current?.focus();
  }, [clearArmed]);

  const cancelClear = () => {
    setClearArmed(false);
    window.requestAnimationFrame(() => clearTrigger.current?.focus());
  };

  const createPosition = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedSymbol = symbol.trim().toUpperCase();
    const parsedQuantity = Number(quantity);

    if (!normalizedSymbol) {
      setFeedback({ kind: "error", message: "Enter a stock symbol to test." });
      return;
    }
    if (
      !Number.isSafeInteger(parsedQuantity) ||
      parsedQuantity < 1 ||
      parsedQuantity > 100_000
    ) {
      setFeedback({
        kind: "error",
        message: "Quantity must be between 1 and 100,000 whole shares.",
      });
      return;
    }
    if (!purchaseDate || purchaseDate > maxPurchaseDate) {
      setFeedback({
        kind: "error",
        message: `Choose a purchase date no later than ${calendarDate(maxPurchaseDate)}.`,
      });
      return;
    }

    refreshAbort.current?.abort();
    mutationInFlight.current = true;
    setIsSubmitting(true);
    setFeedback(null);
    const idempotencyKey =
      pendingIdempotencyKey.current ?? makeIdempotencyKey();
    pendingIdempotencyKey.current = idempotencyKey;

    try {
      const response = await fetch("/api/admin/valuation-lab", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          symbol: normalizedSymbol,
          quantity: parsedQuantity,
          purchaseDate,
        }),
      });
      const payload = await readJson(response);

      if (!response.ok) {
        throw new Error(
          extractError(payload, "The historical purchase could not be added."),
        );
      }
      if (!isPortfolio(payload)) {
        throw new Error("The valuation lab returned an unexpected response.");
      }

      applyPortfolio(payload);
      pendingIdempotencyKey.current = null;
      setSymbol("");
      setFeedback({
        kind: "success",
        message: `${quantityNumber.format(parsedQuantity)} ${normalizedSymbol} share${parsedQuantity === 1 ? "" : "s"} added. ${money(payload.summary.availableCashCents)} remains available.`,
      });
    } catch (error) {
      setFeedback({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The historical purchase could not be added.",
      });
    } finally {
      mutationInFlight.current = false;
      setIsSubmitting(false);
    }
  };

  const updateTestCash = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cashCents = parseCashCents(cashDraft ?? "");
    const committedCostCents = portfolio?.summary.costBasisCents ?? 0;

    if (cashCents === null) {
      setCashFeedback({
        kind: "error",
        message:
          "Enter a non-negative CAD amount with no more than two decimal places.",
      });
      return;
    }
    if (cashCents < committedCostCents) {
      setCashFeedback({
        kind: "error",
        message: `The balance must be at least ${money(committedCostCents)} to cover existing purchases.`,
      });
      return;
    }

    refreshAbort.current?.abort();
    mutationInFlight.current = true;
    setIsUpdatingCash(true);
    setCashFeedback(null);

    try {
      const response = await fetch("/api/admin/valuation-lab", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cashCents }),
      });
      const payload = await readJson(response);

      if (!response.ok) {
        throw new Error(
          extractError(payload, "The test account cash could not be updated."),
        );
      }
      if (!isPortfolio(payload)) {
        throw new Error("The valuation lab returned an unexpected response.");
      }

      applyPortfolio(payload);
      setCashDraft(null);
      setCashFeedback({
        kind: "success",
        message: `Test account cash set to ${money(cashCents)}.`,
      });
    } catch (error) {
      setCashFeedback({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The test account cash could not be updated.",
      });
    } finally {
      mutationInFlight.current = false;
      setIsUpdatingCash(false);
    }
  };

  const clearPortfolio = async () => {
    refreshAbort.current?.abort();
    mutationInFlight.current = true;
    setIsClearing(true);
    setFeedback(null);

    try {
      const response = await fetch("/api/admin/valuation-lab", {
        method: "DELETE",
        credentials: "same-origin",
      });
      const payload = await readJson(response);

      if (!response.ok) {
        throw new Error(extractError(payload, "The test ledger could not be cleared."));
      }
      if (!isPortfolio(payload)) {
        throw new Error("The valuation lab returned an unexpected response.");
      }

      applyPortfolio(payload);
      setClearArmed(false);
      setFeedback({ kind: "success", message: "The test ledger is empty." });
    } catch (error) {
      setFeedback({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The test ledger could not be cleared.",
      });
    } finally {
      mutationInFlight.current = false;
      setIsClearing(false);
    }
  };

  const summary = portfolio?.summary;
  const hasPositions = Boolean(portfolio?.positions.length);
  const busy = isSubmitting || isUpdatingCash || isClearing;
  const cashInputValue =
    cashDraft ?? ((summary?.startingCashCents ?? 0) / 100).toFixed(2);
  const parsedCashDraft = parseCashCents(cashInputValue);
  const minimumCashCents = summary?.costBasisCents ?? 0;
  const cashDraftError =
    cashDraft === null
      ? null
      : parsedCashDraft === null
        ? "Enter a non-negative amount with no more than two decimal places."
        : parsedCashDraft < minimumCashCents
          ? `Enter at least ${money(minimumCashCents)} to cover existing purchases.`
          : null;
  const cashIsUnchanged = parsedCashDraft === (summary?.startingCashCents ?? 0);

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div className={styles.headerCopy}>
            <div className={styles.titleLine}>
              <h1>Past <span aria-hidden="true">→</span> Present Valuation Lab</h1>
              <span className={styles.adminBadge}>Platform admin only</span>
            </div>
            <p>
              Record a stock purchase on a past date, then compare its real
              historical cost with its value at the latest market quote.
            </p>
          </div>
          <div className={styles.headerActions}>
            <button
              className={styles.secondaryButton}
              type="button"
              onClick={() => void loadPortfolio("manual")}
              disabled={isInitialLoading || isRefreshing || busy}
            >
              {isRefreshing ? "Refreshing…" : "Refresh values"}
            </button>
            <Link className={styles.secondaryButton} href="/">
              Trading room
            </Link>
          </div>
        </header>

        <div className={styles.refreshLine} aria-live="polite">
          <span
            className={summary?.hasStaleQuotes ? styles.staleDot : styles.liveDot}
            aria-hidden="true"
          />
          <span>
            Auto-refreshes every 60 seconds
            {lastCheckedAt ? ` · Last checked ${dateTime(lastCheckedAt)}` : ""}
          </span>
        </div>

        {isInitialLoading && !portfolio ? (
          <section className={styles.loadingState} aria-live="polite">
            <strong>Opening the valuation ledger…</strong>
            <span>Resolving the latest market values.</span>
          </section>
        ) : (
          <>
            <section className={styles.summary} aria-labelledby="valuation-summary-heading">
              <div className={styles.summaryPrimary}>
                <p id="valuation-summary-heading">Present portfolio value</p>
                <strong>{money(summary?.totalValueCents ?? 0)}</strong>
                <span className={toneClass(summary?.gainLossCents ?? 0)}>
                  {signedMoney(summary?.gainLossCents ?? 0)} ·{" "}
                  {signedPercent(summary?.returnPercent ?? 0)}
                </span>
              </div>
              <dl className={styles.summaryLedger}>
                <div>
                  <dt>Available cash</dt>
                  <dd>{money(summary?.availableCashCents ?? 0)}</dd>
                </div>
                <div>
                  <dt>Holdings value</dt>
                  <dd>{money(summary?.holdingsValueCents ?? 0)}</dd>
                </div>
                <div>
                  <dt>Starting cash</dt>
                  <dd>{money(summary?.startingCashCents ?? 0)}</dd>
                </div>
                <div>
                  <dt>Gain / loss</dt>
                  <dd className={toneClass(summary?.gainLossCents ?? 0)}>
                    {signedMoney(summary?.gainLossCents ?? 0)}
                  </dd>
                </div>
              </dl>
            </section>

            <div className={styles.workspace}>
              <aside className={styles.purchasePanel} aria-labelledby="purchase-heading">
                <section
                  className={styles.cashEditor}
                  aria-labelledby="cash-editor-heading"
                >
                  <div className={styles.cashEditorHeading}>
                    <div>
                      <h2 id="cash-editor-heading">Test account cash</h2>
                      <p id={cashHelpId}>
                        Set this sandbox account&apos;s exact starting balance.
                        Historical purchases debit available cash at their CAD
                        cost and never affect competition teams.
                      </p>
                    </div>
                    <span>{money(summary?.availableCashCents ?? 0)} available</span>
                  </div>

                  <form onSubmit={(event) => void updateTestCash(event)}>
                    <fieldset disabled={busy || isInitialLoading}>
                      <label htmlFor={cashInputId}>
                        <span>Test account cash (CAD)</span>
                        <input
                          id={cashInputId}
                          type="number"
                          min="0"
                          max="1000000000000"
                          step="0.01"
                          inputMode="decimal"
                          value={cashInputValue}
                          onChange={(event) => {
                            setCashDraft(event.target.value);
                            setCashFeedback(null);
                          }}
                          aria-describedby={`${cashHelpId}${cashDraftError ? ` ${cashValidationId}` : ""}`}
                          aria-invalid={cashDraftError ? "true" : undefined}
                          required
                        />
                      </label>
                      {cashDraftError ? (
                        <p
                          className={styles.fieldError}
                          id={cashValidationId}
                          role="alert"
                        >
                          {cashDraftError}
                        </p>
                      ) : null}
                      <button
                        className={styles.secondaryButton}
                        type="submit"
                        disabled={
                          parsedCashDraft === null ||
                          cashDraftError !== null ||
                          cashIsUnchanged
                        }
                      >
                        {isUpdatingCash ? "Saving test cash…" : "Set test cash"}
                      </button>
                    </fieldset>
                  </form>

                  {cashFeedback ? (
                    <p
                      className={
                        cashFeedback.kind === "error"
                          ? styles.errorMessage
                          : styles.successMessage
                      }
                      role={cashFeedback.kind === "error" ? "alert" : "status"}
                    >
                      {cashFeedback.message}
                    </p>
                  ) : null}
                </section>

                <div className={styles.purchaseIntro}>
                  <h2 id="purchase-heading">Add a historical purchase</h2>
                  <p id={formHelpId}>
                    Use the ticker format shown by its exchange, such as PET.TO
                    for the TSX. Non-trading dates resolve to the market session
                    reported in the ledger. The purchase must fit within the
                    test account&apos;s available cash.
                  </p>
                </div>

                <form onSubmit={(event) => void createPosition(event)}>
                  <fieldset disabled={busy || isInitialLoading}>
                    <label>
                      <span>Stock symbol</span>
                      <input
                        type="text"
                        value={symbol}
                        onChange={(event) => {
                          pendingIdempotencyKey.current = null;
                          setSymbol(event.target.value.toUpperCase());
                        }}
                        placeholder="PET.TO"
                        autoComplete="off"
                        autoCapitalize="characters"
                        spellCheck={false}
                        maxLength={16}
                        aria-describedby={formHelpId}
                        required
                      />
                    </label>
                    <label>
                      <span>Original shares</span>
                      <input
                        type="number"
                        value={quantity}
                        onChange={(event) => {
                          pendingIdempotencyKey.current = null;
                          setQuantity(event.target.value);
                        }}
                        min="1"
                        max="100000"
                        step="1"
                        inputMode="numeric"
                        required
                      />
                    </label>
                    <label>
                      <span>Requested purchase date</span>
                      <input
                        type="date"
                        value={purchaseDate}
                        onChange={(event) => {
                          pendingIdempotencyKey.current = null;
                          setPurchaseDate(event.target.value);
                        }}
                        max={maxPurchaseDate}
                        required
                      />
                    </label>
                    <button className={styles.primaryButton} type="submit">
                      {isSubmitting ? "Resolving market session…" : "Add historical purchase"}
                    </button>
                  </fieldset>
                </form>

                <div className={styles.methodNote} role="note">
                  <strong>Test method</strong>
                  <p>
                    Every purchase debits available cash at its historical CAD
                    cost. Split-adjusted share quantities are included.
                    Dividends, trading fees, taxes, and commissions are excluded.
                  </p>
                </div>
              </aside>

              <section className={styles.ledger} aria-labelledby="positions-heading">
                <div className={styles.ledgerHeading}>
                  <div>
                    <h2 id="positions-heading">Historical positions</h2>
                    <p>
                      Cost and present value are shown in CAD; native listing
                      prices remain visible for auditability.
                    </p>
                  </div>
                  {!clearArmed ? (
                    <button
                      ref={clearTrigger}
                      className={styles.dangerButton}
                      type="button"
                      onClick={() => setClearArmed(true)}
                      disabled={!hasPositions || busy}
                    >
                      Clear test ledger
                    </button>
                  ) : null}
                </div>

                {clearArmed ? (
                  <div className={styles.clearConfirm} role="alert" aria-labelledby={clearHeadingId}>
                    <div>
                      <strong id={clearHeadingId}>Clear every test position?</strong>
                      <span>Your configured test account cash will be kept.</span>
                    </div>
                    <div>
                      <button
                        ref={clearConfirmation}
                        className={styles.dangerButton}
                        type="button"
                        onClick={() => void clearPortfolio()}
                        disabled={isClearing}
                      >
                        {isClearing ? "Clearing…" : "Yes, clear all"}
                      </button>
                      <button
                        className={styles.secondaryButton}
                        type="button"
                        onClick={cancelClear}
                        disabled={isClearing}
                      >
                        Keep positions
                      </button>
                    </div>
                  </div>
                ) : null}

                {feedback ? (
                  <p
                    className={
                      feedback.kind === "error" ? styles.errorMessage : styles.successMessage
                    }
                    role={feedback.kind === "error" ? "alert" : "status"}
                  >
                    {feedback.message}
                  </p>
                ) : null}

                {!hasPositions ? (
                  <div className={styles.emptyState}>
                    <strong>No historical positions yet.</strong>
                    <p>
                      Add a symbol, quantity, and past date to create a clean
                      cost-to-current-value test.
                    </p>
                  </div>
                ) : (
                  <div className={styles.positionList}>
                    {portfolio?.positions.map((position) => (
                      <article
                        className={styles.position}
                        key={position.id}
                        aria-label={`${position.symbol} historical position`}
                      >
                        <header className={styles.positionHeader}>
                          <div className={styles.instrument}>
                            <strong>{position.symbol}</strong>
                            <span>{position.name} · {position.exchange}</span>
                          </div>
                          <div className={styles.positionValue}>
                            <span>Present value</span>
                            <strong>{money(position.currentValueCents)}</strong>
                            <span className={toneClass(position.gainLossCents)}>
                              {signedMoney(position.gainLossCents)} ·{" "}
                              {signedPercent(position.returnPercent)}
                            </span>
                          </div>
                        </header>

                        <dl className={styles.positionFacts}>
                          <div>
                            <dt>Requested date</dt>
                            <dd>{calendarDate(position.requestedDate)}</dd>
                            <small>Admin selection</small>
                          </div>
                          <div>
                            <dt>Actual market session</dt>
                            <dd>{calendarDate(position.sessionDate)}</dd>
                            <small>Provider session timestamp · {dateTime(position.sessionAt)}</small>
                          </div>
                          <div>
                            <dt>Share quantity</dt>
                            <dd>
                              {quantityNumber.format(position.originalQuantity)} →{" "}
                              {quantityNumber.format(position.currentQuantity)}
                            </dd>
                            <small>
                              Original → current · {quantityNumber.format(position.splitMultiplier)}× split factor
                            </small>
                          </div>
                          <div>
                            <dt>Historical close</dt>
                            <dd>
                              <PricePair
                                nativeCents={position.purchasePriceCents}
                                cadCents={position.purchasePriceCadCents}
                                currency={position.listingCurrency}
                              />
                            </dd>
                            <small>Cost basis {money(position.costBasisCents)}</small>
                          </div>
                          <div>
                            <dt>Latest price</dt>
                            <dd>
                              <PricePair
                                nativeCents={position.currentPriceCents}
                                cadCents={position.currentPriceCadCents}
                                currency={position.listingCurrency}
                              />
                            </dd>
                            <small>{dateTime(position.currentQuoteAsOf)}</small>
                          </div>
                          <div>
                            <dt>Market data</dt>
                            <dd>
                              <span
                                className={
                                  position.currentQuoteIsStale
                                    ? styles.staleStatus
                                    : styles.currentStatus
                                }
                              >
                                {position.currentQuoteIsStale ? "Stale quote" : "Current quote"}
                              </span>
                            </dd>
                            <small>
                              {position.sourceUrl ? (
                                <a
                                  className={styles.sourceLink}
                                  href={position.sourceUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {sourceLabel(position.source)} source
                                </a>
                              ) : (
                                sourceLabel(position.source)
                              )}
                            </small>
                          </div>
                        </dl>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
