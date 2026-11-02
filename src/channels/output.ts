import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);
const metric = z.object({ label: text(80), value: text(100), change: text(100).optional() }).strict();
const resource = z.object({ title: text(160), url: text(2048).refine(safeOutputUrl, "Only HTTPS URLs without credentials are supported"),
  description: text(300).optional(), format: text(40).optional() }).strict();
const placement = { after: text(500).optional() };
const block = z.discriminatedUnion("type", [
  z.object({ ...placement, type: z.literal("artifact"), versionId: z.string().uuid(), fileId: z.string().uuid(),
    previousVersions: z.array(z.object({versionId:z.string().uuid(),filename:text(240),size:z.number().int().min(0)}).strict()).max(100).optional(),
    filename: text(240), mime: text(160), size: z.number().int().min(0), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ ...placement, type: z.literal("metrics"), items: z.array(metric).min(1).max(6) }).strict(),
  z.object({ ...placement, type: z.literal("chart"), chartType: z.enum(["bar", "line"]), title: text(120).optional(), unit: text(40).optional(),
    labels: z.array(text(80)).min(1).max(48), series: z.array(z.object({ label: text(80), values: z.array(z.number().finite().min(-1e15).max(1e15)).min(1).max(48) }).strict()).min(1).max(4) }).strict(),
  z.object({ ...placement, type: z.literal("table"), title: text(120).optional(), columns: z.array(text(80)).min(1).max(8),
    rows: z.array(z.array(z.union([z.string().max(300), z.number().finite(), z.null()])).max(8)).max(50) }).strict(),
  z.object({ ...placement, type: z.literal("steps"), items: z.array(z.object({ title: text(160), description: text(500).optional(),
    status: z.enum(["pending", "active", "completed"]) }).strict()).min(1).max(12) }).strict(),
  z.object({ ...placement, type: z.literal("document"), filename: z.string().regex(/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,95}\.md$/u),
    title: text(120).optional(), content: z.string().max(32_000).refine(value => !value.includes("\0"), "Document contains an invalid character") }).strict(),
  z.object({ ...placement, type: z.literal("interactive"), title: text(120).optional(), summary: text(1500),
    html: text(32_000).refine(value => !value.includes("\0"), "HTML contains an invalid character"),
    height: z.number().int().min(240).max(720).optional() }).strict(),
  z.object({ ...placement, type: z.literal("animation"), title: text(120).optional(), summary: text(1500),
    html: text(32_000).refine(value => !value.includes("\0"), "HTML contains an invalid character"),
    duration: z.number().finite().min(1).max(300),
    height: z.number().int().min(240).max(720).optional() }).strict(),
  z.object({ ...placement, type: z.literal("resources"), items: z.array(resource).min(1).max(8) }).strict()
]);

/** Stored artifacts retain legacy tables for existing conversations. Interactive HTML runs only in the web channel's isolated preview, never in the host. */
export const conversationOutputSchema = z.object({
  ...placement, id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), title: text(120), description: text(500).optional(), blocks: z.array(block).min(1).max(8)
}).strict().superRefine((output, context) => {
  output.blocks.forEach((item, index) => {
    if (item.type === "chart") item.series.forEach((series, seriesIndex) => {
      if (series.values.length !== item.labels.length) context.addIssue({ code: z.ZodIssueCode.custom,
        path: ["blocks", index, "series", seriesIndex, "values"], message: "Each chart series must match the labels" });
    });
    if (item.type === "table") item.rows.forEach((row, rowIndex) => {
      if (row.length !== item.columns.length) context.addIssue({ code: z.ZodIssueCode.custom,
        path: ["blocks", index, "rows", rowIndex], message: "Each table row must match the columns" });
    });
  });
  if (JSON.stringify(output).length > 48_000) context.addIssue({ code: z.ZodIssueCode.custom, message: "Output exceeds the 48,000 character limit" });
  if (output.blocks.filter(item => item.type === "interactive" || item.type === "animation").length > 3)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Use at most three interactive/animation blocks combined per output" });
});
/** New tool calls use Markdown in the reply for tables; stored artifacts stay readable. */
export const presentOutputSchema = conversationOutputSchema.superRefine((output, context) => {
  output.blocks.forEach((item, index) => {
    if (item.type === "artifact") context.addIssue({ code: z.ZodIssueCode.custom,
      path: ["blocks", index, "type"], message: "Publish real files with artifact_files; attachment identities are assigned by the server" });
    if (item.type === "table") context.addIssue({ code: z.ZodIssueCode.custom,
      path: ["blocks", index, "type"], message: "Write tables directly as Markdown in your reply, not with present_output or interactive HTML" });
  });
});
export type ConversationOutput = z.infer<typeof conversationOutputSchema>;
export type OutputBlock = ConversationOutput["blocks"][number];

export function safeOutputUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
}

const stringSchema = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const objectSchema = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", additionalProperties: false, properties, required });
const arraySchema = (items: unknown, maxItems: number, minItems = 1) => ({ type: "array", items, minItems, maxItems });
export const outputContinuationInstruction = "Prose before and after tools is one delivered reply. After present_output, add only new information or stop; never repeat earlier prose as a standalone final answer.";
export const outputPlacementInstruction = "Anchor each independently explained figure with its own block.after: an exact complete visible heading/paragraph in this reply. Prefer already delivered text without repeating it; otherwise emit the anchor once after the tool. Never print placement metadata or combine separate explanations' figures in one HTML/tab switcher or at the conclusion. Tabs may vary the same figure's parameters.";
const placementInput = { after: { ...stringSchema(500), description: "Exact visible heading/paragraph anchor; per-block overrides output.after." } };
const typeSchema = (value: string) => ({ type: "string", const: value });
/** Model-facing schema mirrors presentOutputSchema; shape relationships are checked at execution. */
export const conversationOutputInputSchema = objectSchema({
  ...placementInput, id: { ...stringSchema(64), pattern: "^[a-zA-Z0-9_-]{1,64}$", description: "Stable reply key; reuse to update." },
  title: stringSchema(120), description: stringSchema(500), blocks: arraySchema({ anyOf: [
    objectSchema({ ...placementInput, type: typeSchema("metrics"), items: arraySchema(objectSchema({ label: stringSchema(80), value: stringSchema(100), change: stringSchema(100) }, ["label", "value"]), 6) }, ["type", "items"]),
    objectSchema({ ...placementInput, type: typeSchema("chart"), chartType: { type: "string", enum: ["bar", "line"] }, title: stringSchema(120), unit: stringSchema(40),
      labels: arraySchema(stringSchema(80), 48), series: arraySchema(objectSchema({ label: stringSchema(80), values: arraySchema({ type: "number", minimum: -1e15, maximum: 1e15 }, 48) }, ["label", "values"]), 4) }, ["type", "chartType", "labels", "series"]),
    objectSchema({ ...placementInput, type: typeSchema("steps"), items: arraySchema(objectSchema({ title: stringSchema(160), description: stringSchema(500),
      status: { type: "string", enum: ["pending", "active", "completed"] } }, ["title", "status"]), 12) }, ["type", "items"]),
    objectSchema({ ...placementInput, type: typeSchema("document"), filename: { ...stringSchema(99), description: "Safe .md basename, no path/slashes." },
      title: stringSchema(120), content: { type: "string", maxLength: 32000, description: "Markdown data, not executable HTML/scripts or a server path." } }, ["type", "filename", "content"]),
    objectSchema({ ...placementInput, type: typeSchema("interactive"), title: stringSchema(120), summary: { ...stringSchema(1500), description: "Standalone conclusion, sources/assumptions, units and limitations for accessibility/fallback; not visible HTML." },
      html: { ...stringSchema(32000), description: "Self-contained HTML/CSS/JS fragment with SVG/canvas and labeled native controls. Use --ui-text/--ui-muted for text, --ui-line for grids, --ui-bg/--ui-surface for fills and --ui-accent for data; SVG uses currentColor or var(--ui-*). Resolve Canvas colors with window.zigentTheme.color('var(--ui-text)'); never pass raw CSS variable values or hardcode black/white. Use injected .ui-* primitives. Host restores labeled input/select/textarea state on theme redraw. No network, external libraries, navigation, credentials or real actions." },
      height: { type: "integer", minimum: 240, maximum: 720, description: "Initial pixels; default 400." } }, ["type", "summary", "html"]),
    objectSchema({ ...placementInput, type: typeSchema("animation"), title: stringSchema(120),
      summary: { ...stringSchema(1500), description: "Accessible motion description, units, assumptions and limitations; not visible on canvas." },
      html: { ...stringSchema(32000), description: "Self-contained HTML/CSS/JS, SVG/canvas. All text, fills, strokes, axes and grids must use --ui-* tokens; SVG uses currentColor or var(--ui-*), Canvas resolves colors with window.zigentTheme.color('var(--ui-text)'). Never hardcode black/white or pass raw CSS variable values to Canvas. Register exactly one synchronous window.zigentAnimation.render(({time, progress, duration}) => {...}); time/duration are seconds, progress 0–1. Redraw the whole scene from absolute time without accumulated state. Host loops while visible, pauses offscreen, respects reduced motion and restores playback time on theme redraw. Make loops seamless; no playback/timeline/speed controls, timers, requestAnimationFrame, CSS/SMIL animations or autonomous Web Animations. Same isolation as interactive." },
      duration: { type: "number", minimum: 1, maximum: 300, description: "Loop duration in seconds." },
      height: { type: "integer", minimum: 240, maximum: 720 }
    }, ["type", "summary", "html", "duration"]),
    objectSchema({ ...placementInput, type: typeSchema("resources"), items: arraySchema(objectSchema({ title: stringSchema(160), url: { ...stringSchema(2048), description: "Existing credential-free HTTPS URL; no invented files/local paths." },
      description: stringSchema(300), format: stringSchema(40) }, ["title", "url"]), 8) }, ["type", "items"])
  ] }, 8)
}, ["id", "title", "blocks"]);

const plain = (value: unknown) => String(value ?? "—").replace(/[\\*_`\[\]<>]/g, "\\$&").replace(/[\r\n]+/g, " ");
/** Channels without a visual renderer retain the same data and resource meaning. */
export function outputText(output: ConversationOutput): string {
  const lines = [`**${plain(output.title)}**`, ...(output.description ? [plain(output.description)] : [])];
  for (const item of output.blocks) {
    if (item.type === "artifact") lines.push(`文件：${plain(item.filename)}（请在网页下载）`);
    if ("title" in item && item.title) lines.push(`\n**${plain(item.title)}**`);
    if (item.type === "metrics") lines.push(...item.items.map(metric => `${plain(metric.label)}：${plain(metric.value)}${metric.change ? `（${plain(metric.change)}）` : ""}`));
    if (item.type === "steps") lines.push(...item.items.map((step, i) => `${i + 1}. ${step.status === "completed" ? "✓" : step.status === "active" ? "进行中 · " : "待开始 · "}${plain(step.title)}${step.description ? `：${plain(step.description)}` : ""}`));
    if (item.type === "table") lines.push(item.columns.map(plain).join(" / "), ...item.rows.map(row => row.map(plain).join(" / ")));
    if (item.type === "chart") lines.push(...item.labels.map((label, i) => `${plain(label)}：${item.series.map(series => `${plain(series.label)} ${series.values[i]}${plain(item.unit ?? "")}`).join(" / ")}`));
    if (item.type === "resources") lines.push(...item.items.map(resource => `[${plain(resource.title)}](${resource.url.replace(/[()<>\s]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)})${resource.description ? ` · ${plain(resource.description)}` : ""}`));
    if (item.type === "document") lines.push(`文件：${plain(item.filename)}`, ...item.content.split("\n").map(plain));
    if (item.type === "interactive") lines.push(plain(item.summary), "交互控件请在网页端打开此成果；当前渠道显示文字摘要。");
    if (item.type === "animation") lines.push(plain(item.summary), `动态画面 · ${item.duration} 秒；请在网页端播放。`);
  }
  return lines.join("\n");
}
