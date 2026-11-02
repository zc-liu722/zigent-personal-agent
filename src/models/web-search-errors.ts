import type { StreamUpdate } from "./stream-types.js";

/** Keep provider diagnostics out of errors and only retry transient server failures. */
export function nativeWebSearchError(value: unknown): NonNullable<StreamUpdate["webSearchError"]> {
  const raw = value && typeof value === "object" ? (value as { code?: unknown; error_code?: unknown }) : {};
  const candidate = raw.error_code ?? raw.code;
  const code = typeof candidate === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(candidate)
    ? candidate : "web_search_failed";
  return {
    code,
    retryable: !["invalid_tool_input", "query_too_long", "request_too_large", "max_uses_exceeded",
      "unsupported_country", "permission_error", "authentication_error", "invalid_request_error"].includes(code)
  };
}
