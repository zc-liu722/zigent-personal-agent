import type { TaskStore } from "../tasks/store.js";
import type { TaskScope, TaskTrigger } from "../tasks/types.js";

/** Generic task instructions only; personal goals and measurements stay in the owner's private skill/database. */
export const morningHealthTasks: readonly { key: string; title: string; skill: "health"; deliveryPolicy: "always"; trigger: TaskTrigger; instruction: string }[] = [
  {
    key: "health-morning-sleep-v1", title: "睡眠复盘", skill: "health", deliveryPolicy: "always",
    trigger: { type: "health_change", metrics: ["sleep_analysis"], afterTime: "06:00", timezone: "Asia/Shanghai", debounceSeconds: 120, oncePerDay: true },
    instruction: [
      "主动和用户聊聊昨夜睡得怎么样。先读最新健康Skill、按醒来日期查询本次睡眠；今天和昨天的真实感受已由服务端附带projectDiary，不重复查询相同范围，必要时比较少量近期可比记录；沿用Skill的日期、来源、单位和分页规则，使用本库按晚汇总，不查询不存在的分段。没有感受日记也照常开启对话。",
      "昨夜及晨间积压的HRV在本次睡眠复盘中结合睡眠按需解释，优先参考固定快照sleepHrv及可用的实际睡眠边界；不把夜间单点波动当作清醒告警。",
      "开场用自然、简短的两三句话，挑一两个与用户有关的观察说清楚，然后留一个好接话的问题；像熟悉近况的助手发起聊天，不用标题、指标清单、报告式分节或固定问卷。无需逐项报起止时间、深睡/REM占比、效率和完整建议；细节确实帮助解答时再展开。不每次固定说早安或假定刚醒，实际可能只是稍后同步。",
      "先接住已经提供的感受。尚未反馈时，自然问一句醒来后的精神或恢复感受；已经说过就回应其具体内容，不反复追问，也不把下一步建议全部塞进开场。日期有歧义时自然交代对应哪一晚，不机械播报日期。数据仅为片段、旧夜补传或可能仍在睡时，简短说明能看到什么和暂不能确定什么，不当成今天的完整睡眠。已有复盘是对话上下文，不代表讨论充分；手动要求再看时继续补充，不以已聊过或无新数据静默结束。",
      "日程、运动和饮食不设每次必查的流程。只有当前问题需要且会改变理解或建议时才补查相关日期的信息，例如讨论晚睡原因时看相关晚间日程，讨论酸痛或疲劳时看近期训练，用户提到晚餐或夜间不适时看相关饮食。获得足够线索就停止扩展；相关记录不能直接证明因果，不先替用户认定原因。不以单次设备指标作诊断或给出没有依据的健康断言。",
      "用户回复后，在普通对话当轮把真实感受合并记录到对应醒来日的sleep日记，无需再说记住。结合反馈继续讨论恢复、目标与当天锻炼，10:00后回复也照常调整当天尚未完成的安排，已练完则关注后续活动与恢复。调整已确认的运动安排先按当前健康项目规则读取原事件，讨论达成一致后展示同一事件的修改组件，点击确认后才执行，不重复创建；目标/计划的持久变更同样通过组件确认。后台本次只读健康日记、日程和待办，不替用户写感受、创建Todo或改日历；不复制设备明细、不缓存分析结论，Skill只维护有持续价值的个人状态。触发与每日自动通知次数由调度器管理。"
    ].join("\n")
  },
  {
    key: "health-daily-exercise-v1", title: "锻炼安排", skill: "health", deliveryPolicy: "always",
    trigger: { type: "time", schedule: "daily", time: "10:00", timezone: "Asia/Shanghai", maxLatenessSeconds: 3600 },
    instruction: [
      "先了解今天的生活安排，再和用户商量运动怎么放进去。先通过google_calendar查看北京时间今天的相关日程，通过todoist查看今日及逾期待办，并读健康Skill中的目标、已确认计划、昨夜睡眠、同一醒来日已收到的感受和必要的近期训练/疲劳记录。日程和待办需要时完成分页；手动稍晚执行时以当前时间之后的安排为主，不推荐已经过去的时段。",
      "结合固定日程、有明确时间的待办、今天的重要负担和已知习惯，提出一个合适的运动时段、活动和大致时长，必要时给一个备选。日历空白只是候选，不等于用户真的有空；留出合理前后缓冲，不猜通勤时间，不把全天事项视为全天被占满，也不把所有逾期Todo都算作今天必须完成。已有运动日历事件或已确认今日安排先核对并沿用；已经练完则接着聊恢复，不再安排重复训练。",
      "选择活动和建议负荷时，认真使用睡眠感受、近期疲劳/酸痛与训练记录，不只把它们列在报告里。睡眠感受尚未补充或设备未同步时，自然说明这部分还不知道，给可调整的建议，不默认恢复良好、不等待日记齐全。Calendar或Todoist读取失败/未授权时，说明日程或待办暂时没看到，继续商量一个暂定安排，不能称今天空闲，也不在后台启动账号授权、反复重试或停止整个任务。没有训练记录不等于没练，不补做惩罚性训练。",
      "消息写成简短的日常对话：接住已知状态，说今天适合怎么动、为什么选这个时段，再问用户是否方便或更偏好另一个安排。不要甩训练报告、逐项罗列健康与日程数据、强制使用标题清单或一次给多个完整方案；动作细节按对话需要继续展开。刚问过但尚待回复的睡眠问题不催问，已经有的反馈不再问；器械和场地以实际记录为准。",
      "本轮只是提出建议和协商，后台只读日历/待办，不创建或修改任何Todo、日历事件或训练日记。用户在后续普通对话接受具体活动和时间（例如回答六点半可以）后，在该用户回合先核对最新日程与已有运动事件，冲突时先继续商量；无冲突则按当前健康项目规则，用google_calendar提出包含活动、日期、起止时间与内容的日程变更，展示确认组件。只有用户点击确认后才执行；不再口头追问一遍。不把建议写成已确认；未确认、没回复或仅表示还在考虑时不添加。已有同一安排则更新/复用原条目，结果不确定时先查再重试；只有写入成功后告诉用户已添加。运动训练安排写Google Calendar，不建Todoist待办；该例外不扩展到其他日程。",
      "10:00后收到睡眠或恢复反馈，也在普通对话当轮讨论并调整当天尚未完成的活动，已完成则关注后续恢复；达成调整意向后展示原有运动事件的变更组件，点击确认后修改，避免新建副本。真实感受和实际完成按健康记录规范保存，不把建议当作完成，不另存分析缓存；Skill保留稳定目标/计划及必要近期状态，不覆盖长期基线或自动改饮食补剂。本任务的目的就是主动开启当天运动安排的对话，历史讨论不等于安排已经充分。"
    ].join("\n")
  }
];

/** Call only for an explicit owner request. Repeated operational setup updates the same two tasks. */
export function configureMorningHealthTasks(store: TaskStore, scope: TaskScope, initialHealthCursor: number, now = Date.now()) {
  store.assertScope(scope);
  const existing = store.list(scope);
  const legacyTitles: Record<string, string> = { "health-morning-sleep-v1": "晨间睡眠复盘", "health-daily-exercise-v1": "每日锻炼安排" };
  for (const desired of morningHealthTasks) {
    const matches = existing.filter(t => t.title === desired.title || t.title === legacyTitles[desired.key]);
    if (matches.length > 1 || matches.some(t => t.status === "cancelled")) throw new Error("Morning task identities require review");
  }
  return morningHealthTasks.map(({ key, ...desired }) => {
    const task = existing.find(t => t.title === desired.title || t.title === legacyTitles[key]) ?? store.create(scope, desired, now, key, initialHealthCursor);
    if (task.status === "cancelled") throw new Error("Cancelled morning task requires a new explicit task identity");
    const updated = store.update(scope, task.id, { ...desired, status: task.status }, now);
    const source = `health:${updated.id}:r${updated.revision}`;
    if (updated.trigger.type === "health_change" && store.sourceCursor(source) === undefined) store.setSourceCursor(source, initialHealthCursor);
    return updated;
  });
}
