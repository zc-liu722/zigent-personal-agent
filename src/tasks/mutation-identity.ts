import { createHash } from "node:crypto";
export function mutationIdentity(
  context: { taskRunId?: string; sessionId: string; turnId: number },
  value: unknown,
): string {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : value;
  return `${context.taskRunId ?? `${context.sessionId}:${context.turnId}`}:${createHash(
    "sha256",
  )
    .update(JSON.stringify(canonical(value)))
    .digest("hex")}`;
}
