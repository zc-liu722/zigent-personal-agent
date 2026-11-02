import type { ChangeDocument, ChangePreview, TaskChangeState } from "../channels/change-preview.js";
import { taskTriggerDiagram, reusableTriggerDiagram } from "../tasks/trigger-diagram.js";
import { parseReusableTriggerSpec } from "../tasks/reusable.js";
import { replaceMarkdownSections, skillSectionsSchema } from "../skills/service.js";
import { validateTrigger } from "../tasks/schedule.js";
import type { TaskTrigger } from "../tasks/types.js";
import { productivityPresentation } from "./productivity-preview.js";
import { xmindPreview } from "./xmind-preview.js";

type Fields = Record<string, unknown>;
const object = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const pick = (source: Fields, keys: string[]) => Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
function taskTrigger(value: unknown, proactive: boolean): Fields {
  const trigger = { ...validateTrigger(value as TaskTrigger) } as Fields;
  if (proactive && trigger.type === "location") trigger.repeat ??= false;
  if (proactive && trigger.type === "health_change") trigger.timezone ??= "Asia/Shanghai";
  const order = ["type", "schedule", "at", "time", "timezone", "weekdays", "event", "source", "preparation", "metrics", "condition", "afterTime", "oncePerDay", "debounceSeconds",
    "regionId", "regionName", "center", "radiusMeters", "minSpeedKph", "maxSpeedKph", "repeat", "cooldownSeconds", "maxAgeSeconds"];
  return pick(trigger, [...new Set([...order, ...Object.keys(trigger).sort()])]);
}

/** Build comparable user-facing states, using only fields the write actually changes. */
export function operationPreview(tool: string, input: Fields, snapshots: unknown[], title: string, description: string,
  format: (value: unknown) => string): { changes: ChangePreview[]; changeDocuments?: ChangeDocument[]; taskTriggers?: Array<{ before?: TaskTrigger; after?: TaskTrigger }> } {
  const source = object(snapshots[0]), current = object(source.event ?? source.task ?? source.item ?? source.file ?? source);
  const action = String(input.action);
  const change = (before: unknown, after: unknown, label = title): ChangePreview => ({ title: label,
    ...(before === undefined ? {} : { before: format(before) }), ...(after === undefined ? {} : { after: format(after) }) });
  const shared = object(snapshots.map(object).find(snapshot => snapshot.reusableTrigger)?.reusableTrigger);
  if (tool === "schedule") {
    const keys = ["kind", "title", "description", "start", "end", "due", "timezone", "location", "priority", "labels", "project", "parentId", "completed", "reminderMinutes"];
    const before = pick(current, keys);
    const patch = action === "complete" || action === "reopen" ? { completed: action === "complete" } : pick(object(input.item), keys);
    const after = action === "delete" ? undefined : action === "create" ? patch : { ...before, ...patch };
    return { changes: [{ ...change(action === "create" ? undefined : before, after), presentation: productivityPresentation("schedule", action, action === "create" ? undefined : before, after) }] };
  }
  if (tool === "xmind") {
    const map = xmindPreview(input, snapshots, title);
    if (map) return { changes: [map] };
  }
  if (tool === "update_skill" && ["create", "replace", "delete"].includes(action)) {
    const field = input.target === "rules" ? "rules" : "body";
    const before = pick(current, action === "delete" ? ["name", "description"]
      : action === "replace" ? ["name", ...(input.description === undefined ? [] : ["description"]), field] : ["name", "description", "body", "rules"]);
    const after = action === "create" ? { name: input.name, description: input.description, body: input.body, rules: input.rules ?? "" }
      : { ...before, [input.target === "rules" ? "rules" : "body"]: input.content, ...(input.description === undefined ? {} : { description: input.description }) };
    const document = action === "delete" ? current : { ...current, ...after };
    return { changes: [change(action === "create" ? undefined : before, action === "delete" ? undefined : after)],
      changeDocuments: ["body", "rules"].map(field => ({ id: `skill-${field}`, title: `${input.name} · ${field === "rules" ? "规则" : "正文"}`,
        filename: `${input.name}-${field}.md`, content: String(object(document)[field] ?? "") })) };
  }
  const revisions = Array.isArray(shared.revisions) ? shared.revisions.map(object) : [];
  const ruleState = (revision: unknown, status: unknown) => {
    const version = revisions.find(version => version.revision === revision);
    return { title: shared.title, status, ...(revision === undefined ? {} : { activeRevision: revision }),
      ...(version ? { spec: version.spec } : {}), subscriberCount: shared.subscriberCount };
  };
  const rulePreview = (revision: unknown, status: unknown): TaskChangeState | undefined => {
    const value = ruleState(revision, status);
    if (!value.spec) return undefined;
    return { title: String(shared.title ?? "触发规则"), instruction: "执行订阅任务", status: String(status),
      delivery: `版本 ${revision} · ${shared.subscriberCount ?? 0} 个任务`, diagram: reusableTriggerDiagram(parseReusableTriggerSpec(value.spec)) };
  };
  const ruleSource = (revision: unknown) => {
    const version = revisions.find(version => version.revision === revision);
    return version ? parseReusableTriggerSpec(version.spec).source : undefined;
  };
  if (tool === "proactive_tasks" && action.startsWith("trigger_")) {
    if (!shared.id) throw new Error("请先读取要修改的触发规则。");
    const target = action === "trigger_activate" ? input.revision : action === "trigger_rollback" ? shared.previousRevision : shared.activeRevision;
    if (target === undefined || !revisions.some(version => version.revision === target)) throw new Error("未找到要启用的规则修订。");
    const status = action === "trigger_pause" ? "paused" : "active";
    return { changes: [{ ...change(ruleState(shared.activeRevision, shared.status), ruleState(target, status)),
      task: { kind: "trigger-rule", before: rulePreview(shared.activeRevision, shared.status), after: rulePreview(target, status) } }],
      taskTriggers: [{ before: ruleSource(shared.activeRevision), after: ruleSource(target) }] };
  }
  if (["proactive_tasks", "health_tasks", "google_calendar", "todoist"].includes(tool)) {
    const keys = tool === "google_calendar" ? ["summary", "description", "location", "start", "end", "recurrence"]
      : tool === "todoist" ? ["content", "description", "due", "priority", "labels", "is_completed", "project_id", "section_id", "parent_id"]
      : ["title", "instruction", "trigger", "skill", "deliveryPolicy", "status"];
    const before = pick(current, keys);
    let patch = pick(input, keys);
    let taskStates: ChangePreview["task"], taskTriggers: Array<{ before?: TaskTrigger; after?: TaskTrigger }> | undefined;
    if (tool === "google_calendar") for (const key of ["start", "end"]) {
      const value = input[key];
      if (typeof value === "string") patch[key] = value.length === 10 ? { date: value } : { dateTime: value, timeZone: input.time_zone ?? "Asia/Shanghai" };
    }
    if (tool === "todoist") {
      const due = ["due_string", "due_date", "due_datetime"].find(key => input[key] !== undefined);
      if (due) patch.due = { [due]: input[due], ...(input.due_lang ? { due_lang: input.due_lang } : {}) };
      if (["complete_task", "reopen_task"].includes(action)) patch = { is_completed: action === "complete_task" };
    }
    if (["proactive_tasks", "health_tasks"].includes(tool)) {
      if (before.trigger) before.trigger = taskTrigger(before.trigger, tool === "proactive_tasks");
      if (patch.trigger) patch.trigger = taskTrigger(patch.trigger, tool === "proactive_tasks");
      if (tool === "proactive_tasks" && input.delivery_policy !== undefined) patch.deliveryPolicy = input.delivery_policy;
      if (tool === "proactive_tasks" && object(patch.trigger).type === "health_change") patch.skill ??= "health";
      if (action === "create") { patch.status = "active"; patch.deliveryPolicy ??= "conditional"; }
      if (tool === "health_tasks") {
        patch = pick(patch, ["title", "instruction", "trigger", "status"]);
        if (action === "create") patch.deliveryPolicy = "conditional";
        if (["pause", "cancel"].includes(action)) patch = {};
      }
      if (["pause", "resume", "delete", "cancel"].includes(action)) patch.status = action === "pause" ? "paused" : action === "resume" ? "active" : "cancelled";
      const sources: { before?: TaskTrigger; after?: TaskTrigger } = {};
      const state = (value: Fields, side: "before" | "after"): TaskChangeState | undefined => {
        if (!value.trigger) return undefined;
        const trigger = validateTrigger(value.trigger as TaskTrigger);
        const version = trigger.type === "reference" && trigger.triggerId === shared.id
          ? revisions.find(version => version.revision === (side === "after" ? input.activate_revision ?? shared.activeRevision : shared.activeRevision)) : undefined;
        const spec = version ? parseReusableTriggerSpec(version.spec) : undefined;
        sources[side] = spec?.source ?? trigger;
        return { title: String(value.title ?? ""), instruction: String(value.instruction ?? ""),
          ...(value.skill ? { project: value.skill === "health" ? "健康" : String(value.skill) } : {}),
          delivery: value.deliveryPolicy === "always" ? "每次执行后通知" : "按需通知", status: String(value.status ?? "active"),
          diagram: spec ? reusableTriggerDiagram(spec) : taskTriggerDiagram(trigger) };
      };
      taskStates = { ...(action === "create" ? {} : { before: state(before, "before") }), after: state({ ...before, ...patch }, "after") };
      taskTriggers = [sources];
      if (shared.id) for (const agreement of [before, patch]) if (object(agreement.trigger).type === "reference") agreement.trigger = { type: "reference", title: shared.title };
    }
    const creating = action.startsWith("create"), deleting = ["delete_event", "delete_task"].includes(action);
    // Preserve field order: a schedule change should not look like every field moved.
    const after = pick({ ...before, ...patch }, keys);
    const changes = [change(creating ? undefined : before, deleting ? undefined : after)];
    changes[0]!.presentation = productivityPresentation(tool, action, creating ? undefined : before, deleting ? undefined : after);
    if (taskStates?.before || taskStates?.after) changes[0]!.task = taskStates;
    if (shared.id) {
      const target = input.activate_revision ?? shared.activeRevision;
      const version = revisions.find(version => version.revision === target);
      if (!version) throw new Error("请先选择已保存的触发规则修订。");
      if (input.activate_revision !== undefined && object(version.validation).passed !== true) throw new Error("请先验证该规则修订，再提出启用。");
      changes.push(change(input.activate_revision === undefined ? undefined : ruleState(shared.activeRevision, shared.status),
        ruleState(target, input.activate_revision === undefined ? shared.status : "active"), input.activate_revision === undefined ? "使用的触发规则" : "同时启用触发规则"));
      changes[1]!.task = { kind: "trigger-rule", ...(input.activate_revision === undefined ? {} : { before: rulePreview(shared.activeRevision, shared.status) }),
        after: rulePreview(target, input.activate_revision === undefined ? shared.status : "active") };
      taskTriggers?.push({ ...(input.activate_revision === undefined ? {} : { before: ruleSource(shared.activeRevision) }), after: ruleSource(target) });
    }
    return { changes, ...(taskTriggers ? { taskTriggers } : {}) };
  }
  if (tool === "update_skill" && typeof current.body === "string") {
    const sections = skillSectionsSchema.parse(input.action === "replace_sections" ? input.sections : [{ heading: input.heading, content: input.content }]);
    const heading = sections.map(section => section.heading).join("、"), body = current.body;
    const content = replaceMarkdownSections(body, sections);
    let changes: ChangePreview[] = [{ title: heading, before: body, after: content }];
    // Large private files should not block a small section edit. Shorten only
    // unchanged text; the full proposed Markdown remains available separately.
    if (body.length + content.length > 44_000) {
      const oldLines = body.split("\n"), newLines = content.split("\n");
      let start = 0, end = 0;
      while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
      while (end < oldLines.length - start && end < newLines.length - start && oldLines.at(-end - 1) === newLines.at(-end - 1)) end++;
      changes = [{ title: heading, before: oldLines.slice(start, oldLines.length - end).join("\n"), after: newLines.slice(start, newLines.length - end).join("\n"),
        note: "未变更的正文已省略，完整内容可查看项目规则。" }];
    }
    return { changes,
      changeDocuments: [{ id: "skill-state", title: input.name === "health" ? "项目规则（本次提议）" : "技能内容（本次提议）", filename: input.name === "health"
        ? input.target === "rules" ? "health-rules.md" : "private-state.md" : `${input.name}-${input.target ?? "body"}.md`, content }] };
  }
  if (tool === "google_drive") {
    if (action === "update_text_file") {
      const content = String(input.content ?? ""), filename = String(current.name ?? "");
      return { changes: [{ title: filename || title, before: String(input.expected_content ?? ""), after: content,
        presentation: { kind: "document", action, title: filename || "文本文件", format: /\.(md|markdown)$/i.test(filename) ? "Markdown" : "TXT", before: String(input.expected_content ?? ""), after: content } }],
        ...(/\.(md|markdown)$/i.test(filename) ? { changeDocuments: [{ id: "text-file", title: filename, filename, content }] } : {}) };
    }
    if (action === "rename_file") return { changes: [{ ...change({ name: current.name ?? input.expected_name }, { name: input.name }),
      presentation: { kind: "document", action, title: String(input.name ?? "文件"), format: "文件", before: String(current.name ?? input.expected_name ?? ""), after: String(input.name ?? "") } }] };
    if (action === "update_sheet") {
      const cells = (value: unknown): string[][] => Array.isArray(value) ? value.map(row => Array.isArray(row) ? row.map(cell => String(cell ?? "")) : []) : [];
      return { changes: [{ ...change({ range: input.range, values: input.expected_values }, { range: input.range, values: input.values }),
        presentation: { kind: "table", action, title: String(current.name ?? "表格"), range: String(input.range ?? ""), before: cells(input.expected_values), after: cells(input.values) } }] };
    }
    if (["edit_document", "edit_presentation"].includes(action) && input.mode === "replace_text")
      return { changes: [{ title, before: String(input.find_text ?? ""), after: String(input.content ?? ""),
        presentation: { kind: "document", action, title: String(current.name ?? title), format: action === "edit_presentation" ? "幻灯片文字" : "文档片段", before: String(input.find_text ?? ""), after: String(input.content ?? "") },
        note: "展示被替换文字；所选范围内的所有匹配都会替换。" }] };
    if (["edit_document", "edit_presentation"].includes(action)) return { changes: [{ title, after: String(input.content ?? ""),
      presentation: { kind: "document", action, title: String(current.name ?? title), format: action === "edit_presentation" ? "新增幻灯片" : "追加内容", after: String(input.content ?? "") } }] };
    if (action === "create_file") {
      const filename = String(input.name ?? "");
      return { changes: [{ ...change(undefined, pick(input, ["name", "kind", "folder_id", "content"])),
        presentation: { kind: "document", action, title: filename || "云盘文件", format: ({ text: "TXT", folder: "文件夹", document: "文档", spreadsheet: "表格", presentation: "幻灯片" } as Record<string, string>)[String(input.kind)], after: String(input.content ?? "") } }],
        ...(input.kind === "text" && /\.(md|markdown)$/i.test(filename) ? { changeDocuments: [{ id: "text-file", title: `${filename}（本次提议）`, filename, content: String(input.content ?? "") }] } : {}) };
    }
  }
  // Some cloud APIs expose commands without a comparable original. Display the
  // complete reviewed operation, explicitly as an addition to the target.
  return { changes: [{ title, after: description,
    note: "此操作没有可比较的完整原文，以下展示拟执行内容。" }] };
}
