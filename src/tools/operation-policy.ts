import { parseProactiveTaskInput } from "./proactive-task-input.js";
import { macDirectory } from "../codex/types.js";
import { operationDigest } from "./confirmed-operation.js";
import { feishuCommand } from "./feishu-content-policy.js";
import { operationPreview } from "./operation-preview.js";
import type { TaskTrigger } from "../tasks/types.js";
import type { ChangeDocument, ChangePreview } from "../channels/change-preview.js";
import { replaceMarkdownSections, skillSectionsSchema, skillTarget } from "../skills/service.js";
import { parseAgentSkillMutation } from "../skills/agent-skills.js";

type Fields = Record<string, unknown>;
export type OperationRead = { tool: string; input: Fields };
export type OperationDraft = { tool: string; input: Fields; title: string; description: string; reads: OperationRead[]; baseline: string;
  delegationEvidence?: string;
  changes?: ChangePreview[]; changeDocuments?: ChangeDocument[];
  /** Private saved sources for read-only visual context; never included in channel notices. */
  taskTriggers?: Array<{ before?: TaskTrigger; after?: TaskTrigger }>;
  skillBaseline?: { revision: number; body: string; rulesDigest?: string } };
export const confirmationGuidance = "Changes to calendar events, todos, proactive/health tasks, cloud content, skills, private project rules/goals/plans/preferences, location binding/deletion and extra phone notifications require the user's confirmation component, even when explicitly requested in chat. The tool only proposes the exact operation; no write occurs until the user clicks confirm. Do not ask for another verbal confirmation, call legacy confirm actions, or claim pending changes completed. Importing a new server-local document outside existing grants also requires the exact-file confirmation component. Reading already shared documents and factual health diary recording do not need confirmation; other read-only operations remain unchanged. Background tasks must not propose or execute these changes.";
const actions: Record<string, Record<string, string>> = {
  documents: { import_file: "读取本地文档" },
  codex: { connect: "连接执行器", disconnect: "断开执行器", dispatch: "派发项目任务", message: "继续项目任务" },
  schedule: { create: "新建事项", update: "修改事项", complete: "完成待办", reopen: "重开待办", delete: "删除事项" },
  google_calendar: { create_event: "新建日程", update_event: "修改日程", delete_event: "取消日程" },
  todoist: { create_task: "新建待办", update_task: "修改待办", complete_task: "完成待办", reopen_task: "重开待办", delete_task: "删除待办" },
  google_drive: { create_file: "新建云盘文件", rename_file: "重命名云盘文件", update_text_file: "修改文本文件", edit_document: "修改云端文档", update_sheet: "修改云端表格", edit_presentation: "修改云端幻灯片" },
  proactive_tasks: { create: "创建主动任务", update: "修改主动任务", delete: "删除主动任务", pause: "暂停主动任务", resume: "恢复主动任务",
    trigger_activate: "启用触发规则", trigger_rollback: "回退触发规则", trigger_pause: "暂停触发规则", trigger_resume: "恢复触发规则" },
  health_tasks: { create: "创建健康提醒", update: "修改健康提醒", pause: "暂停健康提醒", cancel: "取消健康提醒" },
  user_location: { claim: "绑定定位", revoke: "解绑并清除定位" },
  update_skill: { create: "创建技能", replace: "修改技能", delete: "删除技能", replace_section: "修改技能", replace_sections: "修改技能" }
};
const mcpReads: Record<string, Set<string>> = {
  notion: new Set(["notion-search", "notion-fetch"]),
  xmind: new Set(["xmind_list_mindmaps", "xmind_read_mindmap", "xmind_get_topic", "xmind_list_sheets"])
};
const cloudCommands = new Set(["docs +create", "docs +update", "docs +whiteboard-update", "sheets +workbook-create", "sheets +table-put", "drive files patch"]);
export function operationTitle(tool: string, value: unknown): string | undefined {
  const input = object(value), action = String(input.action ?? "");
  if (tool === "update_skill" && input.name === "health" && ["replace_section", "replace_sections"].includes(action)) return "更新健康项目";
  if (mcpReads[tool] && action === "call" && !mcpReads[tool]!.has(String(input.operation))) return tool === "notion" ? "修改 Notion 内容" : "修改 XMind 导图";
  if (tool === "feishu_cli" && action === "run" && Array.isArray(input.args)) {
    const command = [input.service, ...input.args.slice(0, input.service === "drive" ? 2 : 1)].join(" ");
    return cloudCommands.has(command) ? "修改飞书内容" : undefined;
  }
  const entries = Object.hasOwn(actions, tool) ? actions[tool]! : undefined;
  return entries && Object.hasOwn(entries, action) ? entries[action] : undefined;
}
export function object(value: unknown): Fields { return value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {}; }

const labels: Record<string, string> = {
  path: "文档路径",
  item: "事项", reminderMinutes: "提前提醒（分钟）", completed: "已完成", project: "项目", parentId: "父待办", summary: "标题", content: "内容", description: "说明", location: "地点", start: "开始", end: "结束", time_zone: "时区", recurrence: "重复规则（空列表表示取消重复）",
  calendar_id: "日历", event_id: "日程", task_id: "待办", project_id: "项目", section_id: "分区", parent_id: "父待办", labels: "标签", priority: "优先级（4=P1，1=P4）",
  due_string: "截止或重复规则", due_lang: "日期解析语言", due_date: "截止日期", due_datetime: "截止时间", name: "名称", title: "标题", instruction: "执行内容", trigger: "触发安排",
  delivery_policy: "通知方式", deliveryPolicy: "通知方式", skill: "关联项目", id: "目标", heading: "更新章节", text: "文字", date: "日期", dateTime: "时间", timeZone: "时区",
  due: "截止安排", is_completed: "已完成",
  file_id: "文件", folder_id: "文件夹", kind: "文件类型", mode: "修改方式", range: "单元格范围", values: "写入值", expected_values: "原单元格值", expected_name: "原名称",
  expected_content: "原内容", find_text: "被替换文字", tab_id: "文档标签页", value_input_option: "单元格解析方式", body: "内容", rules: "规则", arguments: "具体变更",
  operation: "操作", type: "类型", schedule: "周期", at: "触发时间", time: "时刻", timezone: "时区", weekdays: "星期（0为周日）", event: "触发事件",
  source: "设备来源", regionId: "地点区域", regionName: "地点名称", center: "地点坐标", latitude: "纬度", longitude: "经度", system: "坐标系", radiusMeters: "范围（米）",
  repeat: "重复触发", cooldownSeconds: "冷却时间（秒）", maxAgeSeconds: "数据有效期（秒）", metrics: "监测指标", debounceSeconds: "合并窗口（秒）",
  minSpeedKph: "最低速度（km/h）", maxSpeedKph: "最高速度（km/h）",
  afterTime: "每日开始时刻", oncePerDay: "每日最多一次通知", condition: "触发条件", preparation: "准备步骤", status: "状态",
  url: "链接", page_url: "页面链接", page_id: "页面", pages: "页面", properties: "属性", children: "内容块", parent: "父位置", data: "内容", command: "修改方式",
  new_str: "新内容", old_str: "原内容", selection_with_ellipsis: "原内容范围", new_content: "新内容", replace_all_matches: "替换所有匹配", topicId: "节点", mindmapId: "导图",
  spec: "规则", delaySeconds: "等待时间（秒）", cancelOn: "取消等待的事件", withinSeconds: "事实有效期（秒）", after: "起始时刻", before: "结束时刻",
  conditions: "组合条件", activeRevision: "启用修订", previousRevision: "之前修订", revision: "修订", subscriberCount: "受影响任务数", activate_revision: "同时启用修订"
};
const readableValues: Record<string, string> = { daily: "每天", weekly: "每周", once: "仅一次", time: "按时间", health_change: "健康数据更新", location: "进出地点", external: "设备事件",
  always: "每次执行后通知", conditional: "满足约定条件时通知", enter: "到达", leave: "离开", active: "启用", paused: "暂停", cancelled: "取消",
  append: "追加内容", append_text: "追加文字", replace_text: "替换文字", append_slide: "新增幻灯片", replace_content: "替换正文", delete_content: "删除正文",
  reference: "复用触发规则", draft: "草稿", time_window: "日期与时段", recent_event: "近期事件", task_delivered: "任务已送达", all: "全部符合", any: "任一符合", not: "条件不符合" };
const internal = new Set(["action", "limit", "expected_revision", "source_request_id", "revision_id", "resource_key"]);
function preview(value: unknown, depth = 0): string {
  if (depth > 12) throw new Error("变更层级过深，请拆分后重新提出。");
  if (typeof value === "string") return value || "（清空）";
  if (value === null) return "（清空）";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.length ? value.map((item, i) => `${i + 1}. ${preview(item, depth + 1)}`).join("\n") : "（空列表）";
  return Object.entries(object(value)).filter(([key]) => !internal.has(key)).map(([key, item]) => {
    if (/secret|password|credential|access.?token|refresh.?token|authorization|cookie/i.test(key)) throw new Error("变更中包含凭据字段，不能送入确认组件。");
    let display = item;
    if (key === "data" && typeof item === "string") { try { display = JSON.parse(item); } catch { /* literal content */ } }
    if (typeof display === "string" && ["due_datetime", "dateTime", "start", "end", "at"].includes(key)) {
      display = display.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/, (_match, date, time, offset) => `${date} ${time}（UTC${offset === "Z" ? "+00:00" : offset}）`);
    }
    if (typeof display === "string" && ["schedule", "type", "event", "status", "mode", "command", "deliveryPolicy", "delivery_policy"].includes(key)) display = Object.hasOwn(readableValues, display) ? readableValues[display] : display;
    return `${Object.hasOwn(labels, key) ? labels[key] : key}：${preview(display, depth + 1)}`;
  }).join("\n");
}
export function operationReads(tool: string, input: Fields): OperationRead[] {
  if (tool === "codex" && input.action === "connect") return [{ tool, input: { action: "pair_preview", code: input.code } }];
  if (tool === "codex" && input.action === "dispatch") {
    const task = object(input.task);
    return [{ tool, input: { action: "devices" } }, ...(task.continueTaskId ? [{ tool, input: { action: "get", id: task.continueTaskId } }] : [])];
  }
  if (tool === "codex" && input.action === "message") return [{ tool, input: { action: "get", id: input.id } }, { tool, input: { action: "devices" } }];
  if (tool === "codex" && input.action === "disconnect") return [{ tool, input: { action: "devices" } }];
  if (tool === "schedule" && input.id) return [{ tool, input: { action: "get", id: input.id } }];
  if (tool === "google_calendar" && input.event_id) return [{ tool, input: { action: "get_event", calendar_id: input.calendar_id ?? "primary", event_id: input.event_id } }];
  if (tool === "todoist" && input.task_id) return [{ tool, input: { action: "get_task", task_id: input.task_id } }];
  if (tool === "proactive_tasks") {
    if (String(input.action).startsWith("trigger_")) {
      if (!input.id) throw new Error("请先明确要修改的触发规则。");
      return [{ tool, input: { action: "trigger_list", id: input.id } }];
    }
    const reads: OperationRead[] = input.id ? [{ tool, input: { action: "list" } }] : [];
    const reference = object(input.trigger);
    if (reference.type === "reference") {
      if (!reference.triggerId) throw new Error("请选择已保存的触发规则。");
      reads.push({ tool, input: { action: "trigger_list", id: reference.triggerId } });
    }
    return reads;
  }
  if (tool === "health_tasks" && input.id) return [{ tool, input: { action: "list" } }];
  if (tool === "update_skill") return [{ tool, input: { action: "read", name: input.name } }];
  if (tool === "google_drive" && input.file_id) return [{ tool, input: { action: "get_file", file_id: input.file_id, ...(input.resource_key ? { resource_key: input.resource_key } : {}) } }];
  if (tool === "notion" && input.operation !== "notion-create-pages") {
    const raw = object(input.arguments);
    let data = raw.data;
    if (typeof data === "string") { try { data = JSON.parse(data); } catch { /* invalid mutation will be rejected */ } }
    const args = { ...raw, ...object(data) };
    const ids = args.page_or_database_ids ?? args.page_ids ?? args.page_id ?? args.id ?? args.url;
    if (!ids) throw new Error("请先明确要修改的 Notion 页面，再提出变更。");
    return (Array.isArray(ids) ? ids : [ids]).map(id => ({ tool, input: { action: "call", operation: "notion-fetch", arguments: { id } } }));
  }
  if (tool === "xmind" && input.operation !== "xmind_create_mindmap") {
    const args = object(input.arguments), id = args.mindmap_id;
    if (!id) throw new Error("请先明确要修改的导图，再提出变更。");
    return [{ tool, input: { action: "call", operation: "xmind_read_mindmap", arguments: { mindmap_id: id } } }];
  }
  if (tool === "feishu_cli" && Array.isArray(input.args)) {
    const args = input.args as string[];
    const { spec } = feishuCommand(String(input.service), args);
    const guides = [...new Set([spec.guide, ...(["+create", "+update"].includes(args[0]!) && input.service === "docs" ? ["docs/format"] : []),
      ...(input.service === "docs" && args[0] === "+update" ? ["docs/read"] : [])])];
    const reads: OperationRead[] = guides.map(resource => ({ tool, input: { action: "guide", resource } }));
    const flag = (key: string) => {
      const item = args.find(arg => arg.startsWith(`--${key}=`));
      return item ? item.slice(key.length + 3) : args[args.indexOf(`--${key}`) + 1];
    };
    if (input.service === "docs" && args[0] === "+update") {
      const doc = args.includes("--doc") || args.some(a => a.startsWith("--doc=")) ? flag("doc") : undefined;
      if (!doc) throw new Error("请明确要修改的飞书文档。");
      reads.push({ tool, input: { action: "run", service: "docs", args: ["+fetch", "--doc", doc, "--scope", "full", "--detail", "full"] } });
    }
    return reads;
  }
  return [];
}
export function operationSnapshots(reads: OperationRead[], results: unknown[], input: Fields): unknown[] {
  return reads.map((read, i) => {
    const value = object(results[i]);
    if (read.tool === "codex" && read.input.action === "devices") {
      const task = object(input.task), target = input.action === "message" ? object(object(results[0]).task) : task;
      const device = Array.isArray(value.devices) ? value.devices.find(item => object(item).id === (input.action === "disconnect" ? input.id : target.deviceId)) : undefined;
      if (!device) throw new Error("设备已失效，请重新连接");
      const saved = object(device);
      if (input.action === "disconnect") return { device: { id: saved.id, name: saved.name, projects: saved.projects } };
      const project = Array.isArray(saved.projects) ? saved.projects.find(item => object(item).id === target.projectId && object(item).available !== false) : undefined;
      if (!project) throw new Error("项目已失效，请重新选择");
      if (input.action === "message" && operationDigest(project) !== operationDigest(target.project)) throw new Error("会话项目已变化，请重新选择");
      return { device: { id: saved.id, name: saved.name }, project };
    }
    if (read.tool === "codex" && read.input.action === "get") {
      const task = object(value.task);
      if (!task.threadId) throw new Error("原会话尚未建立，请等待接单");
      if (input.action === "dispatch" && (!["succeeded", "blocked", "cancelled"].includes(String(task.state))
        || task.deviceId !== object(input.task).deviceId || task.projectId !== object(input.task).projectId)) throw new Error("原会话项目或状态已变化");
      // Progress/revision changes do not alter the agreed recipient.
      return { task: { id: task.id, deviceId: task.deviceId, projectId: task.projectId, project: task.project, threadId: task.threadId, title: task.title } };
    }
    if (read.input.action === "guide") return { guide: read.input.resource };
    if (value.ok === false || value.isError === true) throw new Error("读取目标未成功，请先完成所需的读取或连接步骤。");
    if (value.status === "authorization_pending" || value.status === "not_configured" || value.status === "authorization_required") throw new Error("账号尚未连接；请完成连接后重新提出变更。");
    if (read.input.action === "trigger_list") {
      const trigger = Array.isArray(value.triggers) ? value.triggers.find(trigger => object(trigger).id === read.input.id) : undefined;
      if (!trigger) throw new Error("没有找到要使用的触发规则，请重新查看规则列表。");
      const saved = object(trigger);
      return { reusableTrigger: Object.fromEntries(["id", "title", "status", "revision", "activeRevision", "previousRevision", "subscriberCount", "revisions"]
        .filter(key => saved[key] !== undefined).map(key => [key, saved[key]])) };
    }
    if (read.input.action === "list") {
      const task = Array.isArray(value.tasks) ? value.tasks.find(task => object(task).id === input.id) : undefined;
      if (!task) throw new Error("没有找到要修改的任务，请重新查看任务列表。");
      const plan = object(task);
      // Runtime cursors and last-run timestamps advance without changing the
      // user's agreement. Compare the saved plan/version, not scheduler activity.
      return Object.fromEntries(["id", "title", "instruction", "trigger", "skill", "status", "revision", "deliveryPolicy"]
        .filter(key => plan[key] !== undefined).map(key => [key, plan[key]]));
    }
    if (read.tool === "update_skill") return ["create", "replace", "delete"].includes(String(input.action))
      ? Object.fromEntries(["name", "exists", "revision", "description", "body", "rules"].filter(key => value[key] !== undefined).map(key => [key, value[key]]))
      : { revision: value.revision, body: value[skillTarget(input.target)], ...(value.rulesDigest ? { rulesDigest: value.rulesDigest } : {}) };
    if (read.tool === "feishu_cli") return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !["log_id", "request_id", "trace_id", "requestId", "traceId"].includes(key)));
    return results[i];
  });
}
export function buildOperationDraft(tool: string, input: Fields, snapshots: unknown[]): OperationDraft {
  const title = operationTitle(tool, input);
  if (!title) throw new Error("此操作不在确认范围内。");
  if (tool === "update_skill") {
    if (input.name !== "health") parseAgentSkillMutation(input);
    else if (!["replace_section", "replace_sections"].includes(String(input.action))) throw new Error("health is a protected project skill");
  }
  if (["proactive_tasks", "health_tasks"].includes(tool) && input.title !== undefined && (!String(input.title).trim() || [...String(input.title).trim()].length > 4)) throw new Error("任务名称需要具体且不超过四个字符。");
  if (tool === "proactive_tasks") parseProactiveTaskInput(input);
  let description = "";
  if (tool === "codex" && ["dispatch", "message"].includes(String(input.action))) {
    const task = object(input.task), first = object(snapshots[0]), deviceSnapshot = object(snapshots[input.action === "message" ? 1 : 0]);
    const project = object(deviceSnapshot.project), device = object(deviceSnapshot.device);
    const previous = object(input.action === "message" ? first.task : object(snapshots[1]).task);
    const prompt = input.action === "dispatch" ? task.prompt : input.text;
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 16000) throw new Error("请提供完整提示词（最多 16000 字符）");
    description = `设备：${device.name}\n项目：${project.name}（${project.id}）${project.directory ? `\n路径：${macDirectory(String(project.directory))}` : ""}\n会话：${previous.threadId ? `继续 ${previous.title}（${previous.threadId}）` : "新建会话"}\n\n完整提示词：\n${prompt}`;
    if (description.length > 22000) throw new Error("提示词过长，无法完整展示确认");
    return { tool, input: structuredClone(input), title, description,
      changes: [{ title: "发送至", after: description.slice(0, description.indexOf("\n\n完整提示词：")) }, { title: "完整提示词", after: prompt }],
      reads: operationReads(tool, input), baseline: operationDigest(snapshots) };
  }

  if (tool === "feishu_cli") {
    const args = input.args as string[], offset = input.service === "drive" ? 2 : 1;
    description = `操作：${input.service} ${args.slice(0, offset).join(" ")}\n`;
    for (let i = offset; i < args.length; i++) {
      const raw = args[i]!, equal = raw.indexOf("="), flag = raw.slice(2, equal < 0 ? undefined : equal);
      let value: unknown = equal >= 0 ? raw.slice(equal + 1) : args[i + 1]?.startsWith("--") || !args[i + 1] ? true : args[++i];
      if (["sheets", "styles", "values", "data"].includes(flag) && typeof value === "string") { try { value = JSON.parse(value); } catch { /* validator reports malformed input on execution */ } }
      description += `${labels[flag.replaceAll("-", "_")] ?? flag}：${preview(value)}\n`;
    }
  } else description = preview(input);
  if (snapshots.length) {
    const source = object(snapshots[0]);
    const before = object(source.event ?? source.task ?? source.item ?? source.file ?? source);
    if (tool === "update_skill") {
      if (input.expected_revision !== before.revision) throw new Error("Skill revision conflict: read the current file; all pending section changes use the same expected_revision. Use replace_sections for all edits to one file.");
      if (typeof input.source_request_id !== "string" || !input.source_request_id.trim()) throw new Error("source_request_id is required");
      if (["create", "replace", "delete"].includes(String(input.action))) {
        if (input.action === "create" ? before.exists !== false : before.exists !== true) throw new Error(input.action === "create" ? "Skill already exists" : "Skill is unavailable");
        description = `技能：${input.name}`;
      } else {
        const sections = skillSectionsSchema.parse(input.action === "replace_sections" ? input.sections : [{ heading: input.heading, content: input.content }]);
        description = sections.map(section => {
          const oldLines = String(before.body).split("\n"), newLines = replaceMarkdownSections(String(before.body), [section]).split("\n");
          let start = 0, end = 0;
          while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
          while (end < oldLines.length - start && end < newLines.length - start && oldLines.at(-end - 1) === newLines.at(-end - 1)) end++;
          return `章节：${section.heading}\n\n修改前：\n${oldLines.slice(start, oldLines.length - end).join("\n")}\n\n修改后：\n${newLines.slice(start, newLines.length - end).join("\n")}`;
        }).join("\n\n");
      }
    } else {
      const keys = tool === "schedule" ? ["kind", "title", "description", "start", "end", "due", "timezone", "location", "priority", "labels", "project", "completed", "reminderMinutes"] : tool === "google_calendar" ? ["summary", "start", "end", "location", "recurrence"] : tool === "todoist" ? ["content", "due", "priority", "labels", "is_completed"]
        : tool === "google_drive" ? ["name", "webViewLink"] : ["title", "instruction", "trigger", "status", "deliveryPolicy"];
      description = `当前对象：\n${preview(Object.fromEntries(keys.filter(key => before[key] !== undefined).map(key => [key, before[key]])))}\n\n拟执行变更：\n${description}`;
    }
  }
  if (tool === "google_calendar") description += "\n范围：当前日程 ID；若为重复实例，仅影响该实例；全天日程结束日期不包含当天。";
  if (tool === "google_calendar" && input.action === "create_event") description = description.replace("范围：当前日程 ID；若为重复实例，仅影响该实例；", "范围：创建上述日程及明确列出的重复规则；");
  if (tool === "todoist" && input.action === "complete_task") description += "\n重复待办完成本次后，服务可能生成下一次待办。";
  if (tool === "user_location" && input.action === "revoke") description += "\n将解除定位绑定，并删除全部已保存的定位、区域及地址解析历史。";
  if (tool === "user_location" && input.action === "claim") description += "\n将当前私聊身份绑定到此定位数据源。";
  if (tool === "proactive_tasks" && String(input.action).startsWith("trigger_")) description += "\n此变更影响所有订阅该规则的任务。";
  else if (["proactive_tasks", "health_tasks"].includes(tool)) description += "\n确认后按此约定运行；以后每次触发无需再次确认。";
  if (description.length > 22_000) throw new Error("本次变更过长，无法完整展示确认；请拆分为较小的变更。");
  const display = operationPreview(tool, input, snapshots, title, description, preview);
  // Feishu renders description; web renders changes. Both must show the same exact operation.
  if (tool === "update_skill" && ["create", "replace", "delete"].includes(String(input.action))) {
    description = display.changes.map(change => `${change.title}\n${change.before === undefined ? "" : `\n修改前：\n${change.before}\n`}${change.after === undefined ? "" : `\n修改后：\n${change.after}`}`).join("\n\n");
    if (description.length > 22_000) throw new Error("本次变更过长，无法完整展示确认；请拆分为较小的变更。");
  }
  if (display.changes.reduce((size, change) => size + (change.before?.length ?? 0) + (change.after?.length ?? 0), 0) > 44_000)
    throw new Error("本次变更过长，无法完整展示确认；请拆分为较小的变更。");
  return { tool, input: structuredClone(input), title, description, ...display, reads: operationReads(tool, input), baseline: operationDigest(snapshots),
    ...(tool === "update_skill" && ["replace_section", "replace_sections"].includes(String(input.action)) ? { skillBaseline: { revision: Number(object(snapshots[0]).revision), body: String(object(snapshots[0]).body), ...(object(snapshots[0]).rulesDigest ? { rulesDigest: String(object(snapshots[0]).rulesDigest) } : {}) } } : {}) };
}
