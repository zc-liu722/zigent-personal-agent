export type AgentCommand =
  | { type: "new-session" }
  | { type: "help" };

const commands = new Map<string, AgentCommand>([
  ["/new", { type: "new-session" }],
  ["/help", { type: "help" }]
]);

export function parseAgentCommand(text: string): AgentCommand | undefined {
  return commands.get(text.trim().toLowerCase());
}

export function agentCommandHelp(): string {
  return [
    "可用指令：",
    "- /new：结束当前话题并创建新会话",
    "- /help：查看指令帮助"
  ].join("\n");
}
