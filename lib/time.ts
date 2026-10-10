/**
 * Every time the app shows is in one zone: the markets, the competition and
 * its rules all run on Eastern time. Formatting in a fixed zone also keeps
 * server-rendered text identical to what the browser renders (the servers run
 * in UTC), which React requires when it hydrates the page.
 */
export const DISPLAY_TIME_ZONE = "America/Toronto";

function zonedParts(date: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
}

/** How far the zone's wall clock is ahead of UTC at this instant, in ms. */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone);
  const wallAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return wallAsUtc - Math.floor(date.getTime() / 1_000) * 1_000;
}

/** An instant as a `datetime-local` value ("2026-11-01T23:59") in the zone. */
export function isoToZonedInputValue(
  iso: string,
  timeZone = DISPLAY_TIME_ZONE,
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = zonedParts(date, timeZone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

/**
 * The instant a `datetime-local` value names when read as wall time in the
 * zone, or null when it isn't a valid value. A wall time skipped by a
 * daylight-saving jump resolves to the instant just after the jump.
 */
export function zonedInputValueToIso(
  value: string,
  timeZone = DISPLAY_TIME_ZONE,
): string | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  if (Number.isNaN(wallAsUtc)) return null;

  // Guess with the offset at the wall time, then correct once with the offset
  // at the guessed instant; that settles every daylight-saving boundary.
  const firstGuess = wallAsUtc - zoneOffsetMs(new Date(wallAsUtc), timeZone);
  const settled = wallAsUtc - zoneOffsetMs(new Date(firstGuess), timeZone);
  return new Date(settled).toISOString();
}

/** An instant in words, e.g. "October 8, 2026 at 4:25 p.m. ET". */
export function formatDisplayDateTime(iso: string): string {
  return `${new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TIME_ZONE,
    dateStyle: "long",
    timeStyle: "short",
  }).format(new Date(iso))} ET`;
}
