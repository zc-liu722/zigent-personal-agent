import { userQuestionRequestSchema } from "../channels/user-questions.js";
import type { AgentToolRegistration } from "./registry.js";

const common = { id: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$" },
  question: { type: "string", minLength: 1, maxLength: 1_000 }, header: { type: "string", minLength: 1, maxLength: 12 } };
const choices = { type: "array", minItems: 2, maxItems: 4, items: { type: "object", additionalProperties: false,
  properties: { id: common.id, label: { type: "string", minLength: 1, maxLength: 100 }, description: { type: "string", minLength: 1, maxLength: 500 } },
  required: ["id", "label", "description"] } };

export const userQuestionInstruction = [
  "Use ask_user_question only when missing user information or a real user preference materially changes the next step and cannot be learned from the conversation, memory, or available read tools.",
  "First use information already given. For minor details with a reasonable reversible default, proceed and state your assumption instead of interrupting.",
  "Ask the smallest useful set of clear questions together. Use single_select for one choice, multi_select for several, or text for an open answer; explain each option's effect or tradeoff and avoid leading choices.",
  "Mark a recommended option in its label only when you can justify it, and allow a custom answer unless the valid choices are genuinely closed.",
  "The tool waits for the real user and returns their answers in this same turn. Do not invent, auto-select or prefill an answer, and follow the user's free text including a request to wait or explain.",
  "This tool collects information, not permission: account authorization and changes to user arrangements still require their existing trusted interaction components.",
  "If the user skips or the question expires, no answer or permission was given. Continue only what existing information supports; explain a remaining blocker without repeatedly asking the same question. Never request passwords, tokens or other authentication secrets."
].join(" ");

export function createAskUserQuestionTool(): AgentToolRegistration {
  return {
    executionMode: "sequential",
    definition: { type: "function", name: "ask_user_question", description: userQuestionInstruction,
      input_schema: { type: "object", additionalProperties: false, required: ["questions"], properties: {
        questions: { type: "array", minItems: 1, maxItems: 4, items: { anyOf: [
          { type: "object", additionalProperties: false, properties: { ...common, type: { type: "string", enum: ["single_select", "multi_select"] },
            options: choices, allowOther: { type: "boolean", default: true } }, required: ["id", "question", "header", "type", "options"] },
          { type: "object", additionalProperties: false, properties: { ...common, type: { type: "string", const: "text" },
            placeholder: { type: "string", maxLength: 200 } }, required: ["id", "question", "header", "type"] }
        ] } }
      } } },
    activity: {
      started: () => ({ message: "我需要你补充一些信息，正在等待你的回答。" }),
      completed: (_input, result) => ({ message: result && typeof result === "object" && "status" in result && result.status === "answered"
        ? "我已收到你的回答，会据此继续处理。"
        : result && typeof result === "object" && "status" in result && result.status === "expired"
          ? "问题已过期，我会根据已有信息判断下一步。" : "你已跳过提问，我会根据已有信息继续。" }),
      failed: () => ({ message: "这次未能取得回答，我会根据已有信息判断下一步。" })
    },
    execute: async (input, context) => {
      context.signal?.throwIfAborted();
      if (!context.askUserQuestion || !context.conversationId || !context.userId || context.taskRunId || context.backgroundTaskKind)
        throw new Error("User questions require an interactive user conversation");
      const parsed = userQuestionRequestSchema.safeParse(input);
      if (!parsed.success) throw new Error("Invalid question form: use 1-4 unique questions, 2-4 unique choices and supported question types");
      const result = await context.askUserQuestion(parsed.data);
      context.signal?.throwIfAborted();
      return result;
    }
  };
}
