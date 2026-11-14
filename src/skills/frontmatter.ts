/** Catalogue text comes from frontmatter only. Never summarize the skill body. */
export function skillFrontmatterDescription(markdown: string): string | undefined {
  const text = markdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const fence = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!fence) return undefined;
  const lines = fence[1].split("\n");
  for (let index = 0; index < lines.length; index++) {
    const match = /^description:\s*(.*)$/.exec(lines[index] ?? "");
    if (!match) continue;
    let value = match[1].trim();
    if (value === "" || /^(?:>[+-]?|\|[+-]?)$/.test(value)) {
      const parts: string[] = [];
      for (let next = index + 1; next < lines.length; next++) {
        const line = lines[next] ?? "";
        if (!/^[ \t]/.test(line)) break;
        if (line.trim()) parts.push(line.trim());
        index = next;
      }
      value = parts.join(" ");
    } else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    value = value.replace(/\s+/g, " ").trim();
    if (value) return value;
  }
  return undefined;
}

export const skillDescriptionRequired = "技能正文需要 frontmatter description。请在开头用一两句话写明这个技能做什么、在什么时候使用，然后重试。";
