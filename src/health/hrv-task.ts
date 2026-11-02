import type { TaskStore } from "../tasks/store.js";
import type { TaskProposal, TaskScope } from "../tasks/types.js";
import { HRV_METRIC, HRV_REALTIME_RULE } from "./hrv.js";

export const hrvHealthTask = {
  title: "HRV", skill: "health", deliveryPolicy: "always",
  trigger: { type: "health_change", metrics: [HRV_METRIC], condition: HRV_REALTIME_RULE, timezone: "Asia/Shanghai", debounceSeconds: 60 },
  instruction: [
    "固定算法已经判定新入库 HRV 测量命中实时排查规则。以固定快照顶层 hrv 的采样时间、测量值、相应近期窗口、前序窗口、个人基线、比例和 reasons 作为本次重新核查后的证据，及时发起一次简短的问题排查与建议；trigger.data.hrv 只是较早入队时的证据。这里实时指通过晨间前置条件和重复合并后处理新数据，用户允许延迟几小时上传；放行批次内每条新增/修订测量都按自己的采样时间检查，不能只看批次最新点。是否触发由程序决定，不因今天已提醒、数据是补传或等待全天统计而静默。阈值是工程排查规则，不是疾病诊断界限。",
    "这是最新原始采样及最近30分钟最多三条测量的信号，不是当日日中位数或整夜恢复评估。severe_low/extreme_high 是单点明显异常；recent_low/recent_high 是至少两条近期记录确认且最新值仍在异常方向；sharp_drop 是相对前60分钟内三条测量中位数骤降。先自然说明哪个时刻的新测量和近期变化触发，邀请用户核实当前感受与测量条件，不用单点 HRV 认定身体出了问题。",
    "按用户约定，以服务器收到每条记录的北京时间分类，不是采样时间，也不是后台重试时间。00:00–03:59收到的数据按尚未入睡处理，period.reason=received_before_0400；命中时优先简短提醒早点休息、减少继续熬夜，并自然关心感受，不直接断言身体很累或生病。若这批记录的采样更早，须说清对应时刻；若实际执行时已到白天，不把凌晨未睡的约定延续为现在还没睡。periodPolicy.processedLocalTime可帮助判断当前时段。",
    "积压的昨夜和复盘前HRV留在睡眠复盘，不再单独回放排查。程序仍用真实睡眠记录按采样时刻分流，睡眠记录不进入清醒告警或近期窗口。period.state=unknown表示缺少可用睡眠边界或记录冲突，要说明不确定，不自行套用00:00–08:00睡眠区间。接收时间约定不是检测清醒状态的证据。",
    "固定快照已完成这些去重核查，模型无需再次决定是否通知，也不回放被合并的旧提醒。",
    "先读健康 Skill。只在会改变理解时补查相应采样时段的心率、活动/运动、睡眠和真实感受；运动后、姿势、压力、佩戴或测量变化都可能影响读数，记录未知时不猜原因。不混合其他设备、导出粒度或 HRV 算法；baselineStatus=provisional 表示短历史估计，须说明仍在积累，不称作长期正常范围。升高不能直接等同恢复更好。多条命中合并成一次简短排查，挑出关键时段；采样较早就问当时的感受，并核对后续是否恢复，不能表述为此刻异常。若 anomaliesTruncated=true，结合 totalAnomalies 说明范围，必要时再查询细节，不声称只发生了展示出的几次。",
    "主动开场严格控制在一两句话、一个短段落：先突出一个关键变化，再自然问一个最值得核实、容易回答的问题；凌晨命中则优先提醒早点休息。不要一次塞入背景、多个症状问题和整套恢复建议，细节等用户回复后再展开。没有记录表示未知，不能推断没睡、没运动、饮酒或生病，也不把相关性当作确定原因。已知答案不反复追问。",
    "单次 HRV 不能诊断疾病或支持自行改药；不把个人长期数值低于人群均值当病。仅在用户确有相关症状或持续不适的证据时给相称的就医建议，不凭一次设备波动制造紧急结论。",
    "后台只读日记、日程和待办；不替用户编写感受、改训练Todo或日历、改变药物/补剂，也不另存分析缓存。保持自然简短的对话，避免完整指标报告。用户后续回复时再按健康记录规范保存真实感受并协商调整。"
  ].join("\n")
} satisfies TaskProposal;

/** Explicit owner setup only; preserve pause/cancel intent and never replay pre-setup observations. */
export function configureHrvHealthTask(store: TaskStore, scope: TaskScope, initialHealthCursor: number, now = Date.now()) {
  store.assertScope(scope);
  const matches = store.list(scope).filter(task => task.title === hrvHealthTask.title || task.title === "HRV 波动排查与恢复建议");
  if (matches.length > 1 || matches.some(task => task.status === "cancelled")) throw new Error("HRV task identities require review");
  const existing = matches[0] ?? store.create(scope, hrvHealthTask, now, "health-hrv-anomaly-v1", initialHealthCursor);
  if (existing.status === "cancelled") throw new Error("Cancelled HRV task requires review");
  const task = store.update(scope, existing.id, { ...hrvHealthTask, status: existing.status }, now);
  const source = `health:${task.id}:r${task.revision}`;
  if (store.sourceCursor(source) === undefined) store.setSourceCursor(source, initialHealthCursor);
  return task;
}
