import type { DatabaseSync, StatementSync } from "node:sqlite";

const caches = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
const depths = new WeakMap<DatabaseSync, number>();
const MAX_STATEMENTS = 256;
let transactionId = 0;

/** Cache parameterized application queries per connection, never rows or bindings. */
export function prepareSql(database: DatabaseSync, sql: string): StatementSync {
  // Schema and connection controls must retain their original lifecycle.
  if (!/^\s*(?:SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH)\b/i.test(sql)) return database.prepare(sql);
  let cache = caches.get(database);
  if (!cache) { cache = new Map(); caches.set(database, cache); }
  let statement = cache.get(sql);
  if (statement) cache.delete(sql);
  else statement = database.prepare(sql);
  cache.set(sql, statement);
  if (cache.size > MAX_STATEMENTS) cache.delete(cache.keys().next().value!);
  return statement;
}

export function closeSqlite(database: DatabaseSync): void {
  caches.get(database)?.clear(); caches.delete(database); depths.delete(database);
  database.close();
}

/** Synchronous operations only; savepoints compose with existing outer transactions. */
export function sqliteTransaction<T>(database: DatabaseSync, operation: () => T,
  mode: "write" | "read" | "savepoint" = "write"): T {
  const depth = depths.get(database) ?? 0;
  const nested = mode === "savepoint" || depth > 0 || database.isTransaction === true;
  const name = `zigent_tx_${++transactionId}`;
  database.exec(nested ? `SAVEPOINT ${name}` : mode === "read" ? "BEGIN" : "BEGIN IMMEDIATE");
  depths.set(database, depth + 1);
  try {
    const result = operation();
    database.exec(nested ? `RELEASE SAVEPOINT ${name}` : "COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec(nested ? `ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}` : "ROLLBACK");
    } catch (rollbackError) { throw new AggregateError([error, rollbackError], "SQLite transaction rollback failed"); }
    throw error;
  } finally {
    if (depth) depths.set(database, depth); else depths.delete(database);
  }
}
