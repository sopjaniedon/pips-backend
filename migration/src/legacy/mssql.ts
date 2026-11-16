// Read-only connection to the restored legacy DNN database (login pips_reader = db_datareader on a READ_ONLY db).
import sql from "mssql";

let pool: sql.ConnectionPool | null = null;

export async function legacy(): Promise<sql.ConnectionPool> {
  if (pool) return pool;
  pool = await new sql.ConnectionPool({
    server: "127.0.0.1",
    port: Number(process.env.LEGACY_MSSQL_PORT ?? 14334),
    user: "pips_reader",
    password: process.env.LEGACY_READER_PASSWORD ?? "",
    database: "PipsLegacy",
    options: { encrypt: false, trustServerCertificate: true, readOnlyIntent: true },
    requestTimeout: 120_000,
  }).connect();
  return pool;
}

/** Run a SELECT. Anything that is not a SELECT/WITH is refused before it reaches the server. */
export async function select<T = Record<string, unknown>>(query: string): Promise<T[]> {
  if (!/^\s*(select|with)\b/i.test(query)) throw new Error("legacy: only SELECT queries are allowed");
  const res = await (await legacy()).request().query<T>(query);
  return res.recordset;
}

export async function closeLegacy(): Promise<void> {
  await pool?.close();
  pool = null;
}
