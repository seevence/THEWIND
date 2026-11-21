import type { Db, Sql, Tx } from "@aihot/backend/db";

function isTransaction(db: Db): db is Tx {
  return typeof (db as { savepoint?: unknown }).savepoint === "function";
}

/**
 * Runs `run` in one transaction, or reuses the caller's transaction when `db` already is one.
 * Writers that must leave no partial batch behind share this so a mid-batch SQL failure rolls the
 * whole batch back.
 */
export async function inTransaction<T>(db: Db, run: (tx: Db) => Promise<T>): Promise<T> {
  if (isTransaction(db)) return run(db);
  const sqlDb = db as Sql;
  return sqlDb.begin(async (tx) => run(tx)) as unknown as Promise<T>;
}