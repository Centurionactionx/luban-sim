import type { AssetClass } from "./contracts";

/**
 * Crypto trades in fixed lots of 10^exponent tokens so every price and
 * quantity in the simulator stays a whole number. These helpers are pure and
 * safe to import from client components.
 */

export function lotSizeFromExponent(exponent: number): number {
  return exponent >= 0 ? 10 ** exponent : 1 / 10 ** -exponent;
}

export function lotExponentFromSize(lotSize: number): number {
  return Math.round(Math.log10(lotSize));
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Exact token amount for a whole number of lots, e.g. 3 lots of 0.0001 BTC
 * is "0.0003". Uses string arithmetic so tiny and huge lots never pick up
 * floating-point noise.
 */
export function formatTokenQuantity(quantity: number, lotSize = 1): string {
  const exponent = lotExponentFromSize(lotSize);
  const sign = quantity < 0 ? "-" : "";
  const digits = String(Math.abs(Math.trunc(quantity)));

  if (exponent >= 0) {
    return sign + groupThousands(digits === "0" ? "0" : digits + "0".repeat(exponent));
  }

  const places = -exponent;
  const padded = digits.padStart(places + 1, "0");
  const whole = padded.slice(0, padded.length - places);
  const fraction = padded.slice(padded.length - places).replace(/0+$/, "");
  return sign + groupThousands(whole) + (fraction ? `.${fraction}` : "");
}

/** "share"/"shares" for stocks and ETFs, "lot"/"lots" for crypto. */
export function unitWord(assetClass: AssetClass | undefined, quantity: number): string {
  const singular = assetClass === "CRYPTO" ? "lot" : "share";
  return quantity === 1 ? singular : `${singular}s`;
}

/** Token symbol for a crypto pair, e.g. "BTC" for "BTC-CAD". */
export function cryptoTokenSymbol(symbol: string): string {
  return symbol.replace(/-(?:CAD|USD)$/, "").replace(/\d{4,}$/, "");
}
