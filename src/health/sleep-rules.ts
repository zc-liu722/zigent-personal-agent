/** Exact legacy wording only: preserve all owner edits outside these retired assumptions. */
const replacements: readonly (readonly [string, string])[] = [
  [
    "睡眠只有按晚汇总，跨夜按醒来日框窗查询，核对 sleepStart/sleepEnd，不查询或累计不存在的分段。",
    "睡眠以实际数据流为准：未汇总上传提供 sleep_segment，旧数据可为 sleep_summary。跨夜分段窗口包含前一晚，优先用 health_data action=sleep 获取完整窗口摘要，需要时间分布再 query 分段；不混加分段与旧汇总。"
  ],
  [
    "睡眠跨午夜，按醒来日理解；按醒来日框窗查询汇总，再核对 `sleepStart/sleepEnd`。不要用入睡日框窗。",
    "睡眠跨午夜，按醒来日理解：分段查询必须包含前一晚（例如前一天 18:00 至醒来日当前时间，历史夜晚可至中午，最多48小时），再根据实际边界缩小范围；旧汇总按醒来日框窗，并核对 `sleepStart/sleepEnd`。"
  ],
  [
    "睡眠直接使用按晚汇总，不尝试读取分段。",
    "睡眠先用 `sleep` 获取选定流的完整窗口摘要，必要时 `query` 读取分段；保留历史汇总，但不与分段重复累加。"
  ],
  [
    "| 睡眠汇总 | 只有 `kind=sleep_summary` 的按晚汇总，读 `totalSleep/asleep/core/deep/rem` 等；用醒来日的北京时间窗口查询，再核对 `sleepStart/sleepEnd`。 |",
    "| 睡眠 | `kind=sleep_segment` 含 `observedAt/endAt/values.value/values.qty`；`sleep` 的 `durations` 为小时，按区间去重，显示冲突、缺口和截断。`recordsComplete` 只代表已读完库内窗口，不证明睡眠已结束。旧 `sleep_summary` 使用醒来日查询，不能与分段混加。 |"
  ],
  [
    "本库睡眠数据只有 `kind=sleep_summary` 的按晚汇总，挂在 `.../sleep_summary/<设备名>` 流下，不在 `metric/unspecified` 里，也没有分段记录。其 `observedAt` 与 `values.date` 都取醒来日 00:00（+0800）：查某一晚必须用醒来日框窗，用入睡日框会整条漏掉。",
    "睡眠未汇总上传使用 `.../sleep_segment/<来源>`，旧汇总使用 `.../sleep_summary/<来源>`。先从 status 复制真实流名；分段优先，不混加设备或粒度。`sleep` 必填带时区 `from/to`，最长48小时，可选 `stream`，不需要分页；多流返回 `stream_required`。返回 `format=segments` 时读取 `durations/observedStart/observedEnd/sleepStart/sleepEnd/clippedSegments/invalidSegments`；分段之间无记录的空档不能推断为清醒，`durations.unobserved` 只统计首末记录之间的空档；`inBed` 与睡眠重叠，不与 `totalSleep` 相加。冲突阶段不武断分类。`format=upstream_summaries` 时读取 `summaries` 的原汇总，不能从中恢复阶段时间线。"
  ],
  [
    "本库睡眠只有按晚汇总，运动保留单次摘要。",
    "新睡眠保留阶段分段与时间边界，兼容旧按晚汇总，运动保留单次摘要。"
  ],
  [
    "使用本库按晚汇总，不查询不存在的分段。",
    "先从真实流选择睡眠分段，用sleep取得跨夜窗口摘要，必要时query分段；兼容旧汇总，不混加来源或粒度。"
  ]
];

export function upgradeSleepRules(rules: string): string {
  for (const [before, after] of replacements) rules = rules.replaceAll(before, after);
  return rules;
}
