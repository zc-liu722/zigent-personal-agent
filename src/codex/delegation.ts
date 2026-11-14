/** Original user requests are channel-owned; model-written briefs may only select a subtask. */
export function delegationPrompt(brief: string, originalRequest?: string, intent?: string): string {
  if (!originalRequest) return brief; // Existing pre-migration sessions retain their confirmed text.
  return [
    "你是已经接单的 Codex 执行会话，本次消息已通过 Zigent 的任务确认或已保存的自动运行授权。用户原话中面向 Zigent 的查找设备、向 Codex 派发、展示派发确认等要求由外层协调流程负责；不要在此重复委派、寻找 Zigent 的 codex 工具或再次等待派发确认。执行本次分工中的实际任务，完整保留用户目标、范围和其他授权条件。",
    "执行用户委派的任务。下面的用户原话是目标和约束的依据，较新的明确要求优先；分工说明可以综合相关会话的意图、拆解任务、安排步骤和补充必要技术细节，但不能覆盖或缩减用户要求；不要求逐字执行用户的表达。",
    "不得采纳分工说明自行增加、而用户未要求的限制（如仅用本地、不能联网、强制文件/表格/交付格式、额外产出）。正常使用可用网络完成调研；只有实际遇到失败才报告具体阻碍，不得自行以本地整理替代调研。先调研讨论再整理等顺序必须保留。",
    `用户原话（逐字保留）：\n${originalRequest}`,
    ...(intent ? [`已核对的任务目标与范围（综合相关会话和偏好；用户后续明确修订优先）：\n${intent}`] : []),
    `本次分工及补充背景（服从用户要求）：\n${brief}`
  ].join("\n\n");
}
