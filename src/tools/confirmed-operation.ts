import { createHash } from "node:crypto";
import type { ToolExecutionContext } from "./registry.js";

export function operationDigest(value: unknown): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

// Object identity and the exact payload are code-owned. Neither model arguments nor
// deserialized contexts can grant consent. Only authenticated button handlers use this.
const approvals = new WeakMap<object, { digest: string; baseline?: string }>();
export function isConfirmedOperation(context: ToolExecutionContext, tool: string, input: unknown): boolean {
  return approvals.get(context)?.digest === operationDigest([tool, input]);
}
export async function executeConfirmedOperation<T>(context: ToolExecutionContext, tool: string, input: unknown,
  execute: (context: ToolExecutionContext) => Promise<T>, baseline?: string): Promise<T> {
  const approved = { ...context };
  approvals.set(approved, { digest: operationDigest([tool, input]), baseline });
  try { return await execute(approved); } finally { approvals.delete(approved); }
}

export function confirmedOperationBaseline(context: ToolExecutionContext): string | undefined { return approvals.get(context)?.baseline; }
