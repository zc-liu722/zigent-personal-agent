import { resolve } from "node:path";
import { exportLocations, type LocationExportOptions } from "./location/export.js";

process.umask(0o077);

function cliOptions(argv: readonly string[]): LocationExportOptions {
  const values = new Map<string, string>();
  let includeRaw = false;
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--include-raw") {
      includeRaw = true;
      continue;
    }
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid argument near ${key ?? "end"}`);
    }
    values.set(key.slice(2), value);
    index += 1;
  }
  const database = values.get("database");
  const output = values.get("output");
  if (!database || !output) {
    throw new Error("Usage: location-export --database <sqlite> --output <json> [--from <ISO>] [--to <ISO>] [--minutes <1..43200>] [--include-raw]");
  }
  const minutes = values.has("minutes") ? Number(values.get("minutes")) : undefined;
  return {
    database: resolve(database),
    output: resolve(output),
    ...(values.has("from") ? { from: values.get("from") } : {}),
    ...(values.has("to") ? { to: values.get("to") } : {}),
    ...(minutes === undefined ? {} : { minutes }),
    includeRaw
  };
}

exportLocations(cliOptions(process.argv.slice(2))).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

