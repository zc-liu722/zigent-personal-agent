/** Extract readable MCP blocks without interpreting provider-specific structured data. */
export function mcpTextParts(content: unknown, resourceLabel: string): string[] {
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const record = block as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
      if (record.type === "resource_link" && typeof record.uri === "string") {
        parts.push(`${typeof record.title === "string" ? record.title : resourceLabel}: ${record.uri}`);
      }
      if (record.type === "resource" && record.resource && typeof record.resource === "object") {
        const resource = record.resource as Record<string, unknown>;
        if (typeof resource.text === "string") parts.push(resource.text);
      }
    }
  }
  return parts;
}
