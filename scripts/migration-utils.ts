export const MIGRATION_PLAN_LOCK_KEY = "luban-schema-migration-plan";

/**
 * Git may check text out as CRLF on Windows and LF on Vercel. Migrations are
 * hashed and executed in one canonical form so the same revision cannot
 * produce false checksum drift across operating systems.
 */
export function normalizeSqlSource(source: string): string {
  return source.replace(/\r\n?/g, "\n");
}

export function findUnknownMigrationVersions(
  appliedVersions: readonly string[],
  repositoryVersions: readonly string[],
): string[] {
  const knownVersions = new Set(repositoryVersions);
  return appliedVersions
    .filter((version) => !knownVersions.has(version))
    .sort((left, right) => left.localeCompare(right, "en"));
}
