type HistoryPart = "content" | "thoughts" | "tools" | "commentary";

const visibleAnswers = `CASE WHEN b.role='user' THEN COALESCE((
  SELECT char(10) || group_concat(
    COALESCE(json_extract(a.value,'$.question'),'') || char(10) ||
    COALESCE((SELECT group_concat(o.value,'；') FROM json_each(a.value,'$.selectedOptions') o),'') || char(10) ||
    COALESCE(json_extract(a.value,'$.text'),''), char(10))
  FROM json_each(b.question_answers_json) a), '') ELSE '' END`;
const visibleText = `b.content || ${visibleAnswers}`;

/** One definition for part identity, visibility, ordering and body projection.
 * Paging selects keys first; search and selected messages use the full projection.
 * source is an internal CTE name, never caller input.
 */
export function projectHistoryParts(parts: readonly HistoryPart[], options: {
  source?: "base" | "eligible"; keysOnly?: boolean;
} = {}): string {
  const { source = "base", keysOnly = false } = options;
  const projections: string[] = [];
  const add = (id: string, type: string, text: string, metadata: string, sort: string, from: string, where = "") => {
    const fields = keysOnly ? `b.id AS message_id,${id} AS part_id,${sort} AS sort_key`
      : `b.id AS message_id,${id} AS part_id,${type} AS type,${text} AS text,${metadata} AS metadata,${sort} AS sort_key`;
    projections.push(`SELECT ${fields} FROM ${source} b${from} ${where ? `WHERE ${where}` : ""}`);
  };
  // Mixed-part reads previously expanded every visible answer before pagination.
  // Retain malformed-answer failures while avoiding copies of every message body.
  if (parts.includes("content")) add("'content'", "'content'", visibleText, "'{}'", "'z'", "",
    keysOnly && parts.length > 1 ? `(${visibleAnswers}) IS NOT NULL` : "");
  if (parts.includes("thoughts") || parts.includes("commentary") || parts.includes("tools")) {
    const types = [parts.includes("thoughts") ? "'thought'" : "", parts.includes("commentary") ? "'commentary'" : "",
      parts.includes("tools") ? "'tool'" : ""].filter(Boolean).join(",");
    add("'activity:' || a.key",
      "CASE json_extract(a.value,'$.type') WHEN 'tool' THEN 'tool_activity' ELSE json_extract(a.value,'$.type') END",
      `CASE json_extract(a.value,'$.type') WHEN 'tool' THEN json_object(
        'message',json_extract(a.value,'$.presentation.message'),'details',json_extract(a.value,'$.presentation.details'),
        'resources',json_extract(a.value,'$.presentation.resources')) ELSE COALESCE(json_extract(a.value,'$.text'),'') END`,
      `json_object('source',json_extract(a.value,'$.source'),'status',json_extract(a.value,'$.status'),
        'tool_name',json_extract(a.value,'$.name'),'duration_ms',json_extract(a.value,'$.durationMs'))`,
      "printf('a:%010d',a.key)", ",json_each(b.activity_trace_json) a",
      `b.role='assistant' AND json_extract(a.value,'$.type') IN (${types})
        AND COALESCE(json_extract(a.value,'$.presentation.hidden'),0)=0`);
  }
  if (parts.includes("tools")) {
    add("'trace:' || t.key || ':search'", "'tool_context'", "json_extract(t.value,'$.searchEvidence')",
      "json_object('tool_name','web_search')", "printf('t:%010d:0:search',t.key)", ",json_each(b.tool_trace_json) t",
      "b.role='assistant' AND json_extract(t.value,'$.role')='assistant' AND json_extract(t.value,'$.searchEvidence.version')=1");
    add("'trace:' || t.key || ':call:' || c.key", "'tool_call'", "COALESCE(json_extract(c.value,'$.arguments'),'null')",
      "json_object('tool_name',json_extract(c.value,'$.name'),'tool_call_id',json_extract(c.value,'$.id'))",
      "printf('t:%010d:1:%010d',t.key,c.key)", ",json_each(b.tool_trace_json) t,json_each(t.value,'$.toolCalls') c",
      "b.role='assistant' AND json_extract(t.value,'$.role')='assistant'");
    add("'trace:' || t.key", "CASE json_extract(t.value,'$.role') WHEN 'tool' THEN 'tool_result' WHEN 'user' THEN 'tool_context' ELSE 'tool_text' END",
      `CASE json_extract(t.value,'$.role') WHEN 'tool' THEN COALESCE(json_extract(t.value,'$.value'),'')
        ELSE COALESCE(json_extract(t.value,'$.text'),'') END`,
      "json_object('tool_call_id',json_extract(t.value,'$.toolCallId'),'failed',json_extract(t.value,'$.failed'))",
      "printf('t:%010d:0',t.key)", ",json_each(b.tool_trace_json) t",
      `b.role='assistant' AND (json_extract(t.value,'$.role')='tool'
        OR (json_extract(t.value,'$.role') IN ('assistant','user') AND length(json_extract(t.value,'$.text'))>0))`);
  }
  return projections.join(" UNION ALL ");
}
