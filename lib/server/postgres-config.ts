import { readFileSync } from "node:fs";
import type { PoolConfig } from "pg";

/** Keep certificate verification enabled even when a provider URL says require. */
export function postgresConnectionOptions(
  connectionString: string,
  certificateAuthority = process.env.LUBAN_DATABASE_CA_CERT,
): Pick<PoolConfig, "connectionString" | "ssl"> {
  const url = new URL(connectionString);
  const mode = url.searchParams.get("sslmode");
  const rootPath = url.searchParams.get("sslrootcert");
  const certPath = url.searchParams.get("sslcert");
  const keyPath = url.searchParams.get("sslkey");
  const explicitSsl = url.searchParams.get("ssl");
  const ca = certificateAuthority?.trim() ||
    (rootPath ? readFileSync(rootPath, "utf8") : undefined);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const tlsRequested = Boolean(ca || certPath || keyPath) ||
    (mode !== null && mode !== "disable") || explicitSsl === "true" || explicitSsl === "1";

  // pg lets these URL fields overwrite the explicit ssl object.
  for (const param of ["sslmode", "ssl", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat"]) {
    url.searchParams.delete(param);
  }

  return {
    connectionString: url.toString(),
    ssl: local && !tlsRequested ? false : {
      rejectUnauthorized: true,
      ...(ca ? { ca } : {}),
      ...(certPath ? { cert: readFileSync(certPath, "utf8") } : {}),
      ...(keyPath ? { key: readFileSync(keyPath, "utf8") } : {}),
    },
  };
}
