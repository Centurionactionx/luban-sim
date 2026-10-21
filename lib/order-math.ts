/**
 * Order arithmetic and limits shared by the server and the order ticket, so
 * both always agree to the cent. Pure and safe to import from client components.
 */

/** Most shares (lots) one order can name. */
export const MAX_ORDER_QUANTITY = 100_000;

/** Most orders a team can have waiting at once. */
export const MAX_OPEN_WORKING_ORDERS_PER_TEAM = 20;

/** The highest price an order can name: $100 million per share or lot. */
export const MAX_ORDER_PRICE_CENTS = 10_000_000_000;

/** Most different listings a team can hold or have waiting buys for at once. */
export const MAX_DISTINCT_HOLDINGS_PER_TEAM = 25;

/**
 * Whether buying `symbol` would open a new holding past the limit. `symbols`
 * are the ones the team already holds or has waiting buys for.
 */
export function holdingsLimitReached(symbols: Iterable<string>, symbol: string): boolean {
  const distinct = new Set(symbols);
  return !distinct.has(symbol) && distinct.size >= MAX_DISTINCT_HOLDINGS_PER_TEAM;
}

/**
 * How much more a team can short, CAD cents: all its shorts together can be
 * worth at most its portfolio value (cash plus holdings, shorts counted
 * negative). About what a real 50% margin account allows.
 */
export function shortRoomCents(portfolioValueCents: number, shortLiabilityCents: number): number {
  return Math.max(0, portfolioValueCents - shortLiabilityCents);
}

/** A holding: positive quantity is long, negative is short. */
export interface Position {
  quantity: number;
  /** Average buy price of a long, or average sale price of a short, CAD cents. */
  averageCostCents: number;
}

/**
 * A fill applied to a position, using the trade engine's average-cost rules:
 * adding to a position on the same side blends the average (rounded to the
 * cent), reducing it keeps the average and realizes the difference, and an
 * order that crosses zero closes the old side and opens the rest at the fill
 * price. `grossCents` is the fill price times `quantity`.
 */
export function applyFill(
  position: Position,
  side: "BUY" | "SELL",
  quantity: number,
  grossCents: number,
): Position & { realizedCents: number; closedQuantity: number } {
  const delta = side === "BUY" ? quantity : -quantity;
  const held = position.quantity;
  if (held === 0 || Math.sign(held) === Math.sign(delta)) {
    const after = held + delta;
    return {
      quantity: after,
      averageCostCents: Math.round(
        (Math.abs(held) * position.averageCostCents + grossCents) / Math.abs(after),
      ),
      realizedCents: 0,
      closedQuantity: 0,
    };
  }
  const closedQuantity = Math.min(quantity, Math.abs(held));
  const closedProceedsCents = (grossCents / quantity) * closedQuantity;
  const closedCostCents = closedQuantity * position.averageCostCents;
  const realizedCents =
    held > 0 ? closedProceedsCents - closedCostCents : closedCostCents - closedProceedsCents;
  const after = held + delta;
  return {
    quantity: after,
    averageCostCents:
      after === 0 ? 0 : closedQuantity < quantity ? grossCents / quantity : position.averageCostCents,
    realizedCents,
    closedQuantity,
  };
}

/**
 * CAD cents a waiting buy sets aside per share (per lot): its price in the
 * listing currency at today's exchange rate, rounded up, plus 2% on USD
 * listings so ordinary USD/CAD movement before the fill can't leave it short.
 * Integer arithmetic, so no floating-point rounding can make the two sides
 * disagree.
 */
export function reservedCadCentsPerUnit(
  priceCents: number,
  fxRateBasisPoints: number,
  listingCurrency: "CAD" | "USD",
): number {
  const price = BigInt(Math.round(priceCents));
  const fx = BigInt(Math.round(fxRateBasisPoints));
  const [multiplier, divisor] =
    listingCurrency === "USD"
      ? [BigInt(102), BigInt(1_000_000)]
      : [BigInt(1), BigInt(10_000)];
  const numerator = price * fx * multiplier;
  return Number((numerator + divisor - BigInt(1)) / divisor);
}

/**
 * A price typed per share, or per whole token for crypto, as whole cents per
 * share (per lot). Crypto lots are 10^lotExponent tokens, so a typed price
 * rarely lands on a whole cent per lot: it is rounded in the trader's favour,
 * "down" for buys and stops, "up" for sells at a target. Exact decimal
 * arithmetic, no floats. Returns null for anything that isn't a positive
 * price with at most `maxDecimals` decimals, and 0 for a positive price
 * worth less than a cent per lot.
 */
export function priceInputToCents(
  value: string,
  options: { lotExponent: number; round: "down" | "up"; maxDecimals: number },
): number | null {
  const trimmed = value.trim().replace(/^\$/, "").replace(/,/g, "");
  const match = new RegExp(`^(\\d*)(?:\\.(\\d{0,${options.maxDecimals}}))?$`).exec(trimmed);
  if (!match || (!match[1] && !match[2])) return null;
  const fraction = match[2] ?? "";
  const digits = BigInt(`${match[1] || "0"}${fraction}` || "0");
  if (digits === BigInt(0)) return null;
  // cents per lot = amount * 100 * 10^lotExponent = digits * 10^shift
  const shift = 2 + options.lotExponent - fraction.length;
  let cents: bigint;
  if (shift >= 0) {
    cents = digits * BigInt(10) ** BigInt(shift);
  } else {
    const divisor = BigInt(10) ** BigInt(-shift);
    cents = digits / divisor;
    if (options.round === "up" && digits % divisor !== BigInt(0)) cents += BigInt(1);
  }
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(cents);
}
