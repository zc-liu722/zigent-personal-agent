import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { manifestSchema, type Manifest } from "./schemas.js";

/** Parse without materializing runtime secrets; receiver and broker startup stay independent. */
export async function readManifest(path: string, errors: "detailed" | "health" | "zod" = "detailed"): Promise<Manifest> {
  const value: unknown = JSON.parse(await readFile(resolve(path), "utf8"));
  if (errors === "zod") return manifestSchema.parse(value);
  const parsed = manifestSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (errors === "health") throw new Error("Invalid agent manifest for health receiver");
  throw new Error(`Invalid agent manifest: ${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join(", ")}`);
}
