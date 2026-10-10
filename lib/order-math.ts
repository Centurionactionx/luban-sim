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

/**
 * Most of a team's total value one holding can reach by buying, in percent.
 * The server can override it with LUBAN_MAX_POSITION_PERCENT.
 */
export const MAX_POSITION_PERCENT = 25;

/**
 * CAD cents of a listing a team can still buy before that holding passes
 * limitPercent of the portfolio. A buy only swaps cash for shares at
 * the same price, so the total value is the same before and after it.
 */
export function positionRoomCents(
  totalValueCents: number,
  holdingValueCents: number,
  limitPercent: number = MAX_POSITION_PERCENT,
): number {
  return Math.max(0, Math.floor((totalValueCents * limitPercent) / 100) - holdingValueCents);
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
