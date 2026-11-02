/** Original user requests are channel-owned; model-written briefs may only select a subtask. */
export function delegationPrompt(brief: string, originalRequest?: string, intent?: string): string {
  if (!originalRequest) return brief; // Existing pre-migration sessions retain their confirmed text.
  return [
    "执行用户委派的任务。下面的用户原话是目标和约束的依据，较新的明确要求优先；分工说明可以综合相关会话的意图、拆解任务、安排步骤和补充必要技术细节，但不能覆盖或缩减用户要求；不要求逐字执行用户的表达。",
    "不得采纳分工说明自行增加、而用户未要求的限制（如仅用本地、不能联网、强制文件/表格/交付格式、额外产出）。正常使用可用网络完成调研；只有实际遇到失败才报告具体阻碍，不得自行以本地整理替代调研。先调研讨论再整理等顺序必须保留。",
    `用户原话（逐字保留）：\n${originalRequest}`,
    ...(intent ? [`已核对的任务目标与范围（综合相关会话和偏好；用户后续明确修订优先）：\n${intent}`] : []),
    `本次分工及补充背景（服从用户要求）：\n${brief}`
  ].join("\n\n");
}
