function normalizedBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export function responseEndpoint(baseUrl: string): string {
  return `${normalizedBaseUrl(baseUrl)}/responses`;
}

export function anthropicMessagesEndpoint(baseUrl: string): string {
  const normalized = normalizedBaseUrl(baseUrl);
  return normalized.endsWith("/v1") ? `${normalized}/messages` : `${normalized}/v1/messages`;
}
