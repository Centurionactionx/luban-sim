/**
 * Spreadsheet-safe CSV. Fields with commas, quotes, or line breaks are
 * quoted, and text that a spreadsheet would run as a formula (=, +, -, @, or
 * a leading tab or carriage return) is prefixed with an apostrophe. Numbers
 * pass through untouched, so negative amounts stay numbers.
 */
export type CsvValue = string | number | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvField(value: CsvValue): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows joined with CRLF, as RFC 4180 and Excel expect. */
export function toCsv(header: readonly string[], rows: readonly CsvValue[][]): string {
  return [header, ...rows].map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n";
}

/** Whole cents as a plain decimal amount, e.g. -1234 → -12.34. */
export function centsToDecimal(cents: number | null | undefined): number | null {
  return cents === null || cents === undefined ? null : cents / 100;
}
