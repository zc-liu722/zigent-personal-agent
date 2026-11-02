import type { TaskStore } from "./store.js";
import type { TaskScope } from "./types.js";

const rules = [
  { title: "睡眠复盘", type: "health_change", prefix: "北京时间每天06:00后收到新睡眠数据，", replacement: "", cleaned: "主动和用户聊聊昨夜睡得怎么样" },
  { title: "锻炼安排", type: "time", prefix: "北京时间每天10:00，", replacement: "", cleaned: "先了解今天的生活安排" },
  { title: "周复盘", type: "time", prefix: "每周日晚上做健康项目周复盘", replacement: "做健康项目周复盘", cleaned: "做健康项目周复盘" },
  { title: "出勤", type: "time", prefix: "每周日中午询问用户下周的出勤安排", replacement: "询问用户下周的出勤安排", cleaned: "询问用户下周的出勤安排" },
] as const;
const hrvGateClause = "配置了每日睡眠复盘时，每天04:00起先等待当天睡眠复盘完成且确认送达，然后只放行复盘送达之后的新采样；";
const redundantTimingClauses = ["程序会等本次复盘完成并确认送达后才释放当天独立HRV排查，只检查放行之后的新采样；不用等待用户回复感受。", "复盘失败、等待发送或送达不确定都不放行。", "程序合并60秒内的上传，同来源同方向的重复信号在90分钟内合并；升级为明显异常、相对前次提醒进一步恶化25%或异常方向改变仍可触发，没有每日次数限制。"];

/** Operates on saved task data only; time ranges describing evidence remain untouched. */
export function normalizeTaskTiming(store: TaskStore, scope: TaskScope) {
  const owned = store.list(scope).filter(task => task.principalId === scope.principalId && task.status !== "cancelled");
  const selected = [...rules.map(rule => rule.title), "HRV"].map(title => {
    const matches = owned.filter(task => task.title === title);
    if (matches.length !== 1) throw new Error("TASK_TIMING_AMBIGUOUS");
    return matches[0]!;
  });
  const changes = selected.map(task => {
    let instruction = task.instruction;
    const rule = rules.find(rule => rule.title === task.title);
    if (rule) {
      if (task.trigger.type !== rule.type) throw new Error("TASK_TIMING_TRIGGER_CHANGED");
      if (instruction.startsWith(rule.prefix)) instruction = rule.replacement + instruction.slice(rule.prefix.length);
      else if (!instruction.startsWith(rule.cleaned)) throw new Error("TASK_TIMING_INSTRUCTION_CHANGED");
      if (task.title === "睡眠复盘" && (task.trigger.type !== "health_change" || task.trigger.afterTime !== "06:00")) throw new Error("TASK_TIMING_TRIGGER_CHANGED");
      const expected = task.title === "锻炼安排" ? ["daily", "10:00"] : task.title === "周复盘" ? ["weekly", "21:00"] : ["weekly", "12:00"];
      if (task.trigger.type === "time" && (task.trigger.schedule !== expected[0] || task.trigger.schedule === "once"
        || task.trigger.time !== expected[1] || task.trigger.timezone !== "Asia/Shanghai"
        || task.trigger.schedule === "weekly" && JSON.stringify(task.trigger.weekdays) !== "[0]")) throw new Error("TASK_TIMING_TRIGGER_CHANGED");
    } else {
      if (task.trigger.type !== "health_change" || task.trigger.condition !== "hrv_realtime_v2") throw new Error("TASK_TIMING_TRIGGER_CHANGED");
      if (instruction.includes(hrvGateClause)) instruction = instruction.replace(hrvGateClause, "");
      else if (!instruction.includes("period.reason=received_before_0400")) throw new Error("TASK_TIMING_INSTRUCTION_CHANGED");
    }
    for (const clause of redundantTimingClauses) instruction = instruction.replace(clause, "");
    return { id: task.id, expectedRevision: task.revision, instruction,
      trigger: task.trigger.type === "time" ? { ...task.trigger, maxLatenessSeconds: 3600 } : task.trigger };
  });
  const updated = store.updateTimingBatch(scope, changes);
  return updated.map((task, index) => ({ title: task.title, status: task.status, revision: task.revision,
    changed: task.revision !== selected[index]!.revision, triggerType: task.trigger.type,
    ...(task.trigger.type === "time" ? { maxLatenessSeconds: task.trigger.maxLatenessSeconds } : {}),
    promptSchedulingRemoved: !rules.some(rule => task.instruction.startsWith(rule.prefix)) && !task.instruction.includes(hrvGateClause) }));
}
