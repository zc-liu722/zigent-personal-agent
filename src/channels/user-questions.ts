import { randomUUID } from "node:crypto";
import { z } from "zod";

export const USER_QUESTION_TTL_MS = 30 * 60_000;
export const USER_QUESTION_TEXT_LIMIT = 4_000;
const CLOSE_DELIVERY_WAIT_MS = 1_000;
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
  .refine(value => !["__proto__", "prototype", "constructor"].includes(value));
const option = z.object({ id: identifier, label: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(500) }).strict();
const base = { id: identifier, question: z.string().trim().min(1).max(1_000), header: z.string().trim().min(1).max(12) };
const question = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("single_select"), options: z.array(option).min(2).max(4), allowOther: z.boolean().default(true) }).strict(),
  z.object({ ...base, type: z.literal("multi_select"), options: z.array(option).min(2).max(4), allowOther: z.boolean().default(true) }).strict(),
  z.object({ ...base, type: z.literal("text"), placeholder: z.string().trim().max(200).optional() }).strict()
]);
export const userQuestionRequestSchema = z.object({ questions: z.array(question).min(1).max(4), purpose: z.literal("workspace").optional() }).strict().superRefine((value, context) => {
  if (new Set(value.questions.map(item => item.id)).size !== value.questions.length)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["questions"], message: "Question IDs must be unique" });
  for (const [index, item] of value.questions.entries()) if (item.type !== "text"
    && new Set(item.options.map(entry => entry.id)).size !== item.options.length)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["questions", index, "options"], message: "Option IDs must be unique" });
});

export type UserQuestionRequest = z.infer<typeof userQuestionRequestSchema>;
export type UserQuestion = UserQuestionRequest["questions"][number];
export const userQuestionAnswersSchema = z.record(identifier, z.object({
  selectedOptionIds: z.array(identifier).max(4).optional(), text: z.string().max(USER_QUESTION_TEXT_LIMIT).optional()
}).strict()).refine(value => Object.keys(value).length <= 4);
export type UserQuestionAnswers = z.infer<typeof userQuestionAnswersSchema>;
export type UserQuestionResult = {
  status: "answered" | "cancelled" | "expired";
  answers?: Record<string, { question: string; selectedOptionIds: string[]; selectedOptions: string[]; text?: string }>;
};
export type UserQuestionNotice = {
  id: string; userId: string; conversationId: string; sessionId: string; messageId?: string;
  questions: UserQuestion[]; status: "pending" | "completed" | "cancelled" | "expired" | "failed";
  purpose?: "workspace";
  expiresAt: number; statusMessage: string; answers?: UserQuestionAnswers;
  /** The form survives shutdown; its answer must start a new turn after restart. */
  resumeAfterRestart?: boolean;
};
export type UserQuestionAction = {
  type: "question-answer"; requestId: string; answers?: UserQuestionAnswers; cancel?: boolean;
};
export type UserQuestionScope = { userId: string; conversationId: string; sessionId: string; signal?: AbortSignal };

type PendingQuestion = {
  notice: UserQuestionNotice; resolve: (result: UserQuestionResult) => void; reject: (error: unknown) => void;
  timer: NodeJS.Timeout; signal?: AbortSignal; onAbort?: () => void;
  delivery: Promise<void>; inFlight?: boolean;
};

/** In-process question checkpoints. Only the original user's scoped answer resumes the suspended tool. */
export class UserQuestions {
  private readonly requests = new Map<string, PendingQuestion>();
  private closed = false;
  constructor(private readonly deliver: (notice: UserQuestionNotice) => Promise<{ messageId: string }>,
    private readonly ttlMs = USER_QUESTION_TTL_MS) {}

  private publish(pending: PendingQuestion): Promise<void> {
    const snapshot = structuredClone(pending.notice);
    const work = pending.delivery.catch(() => undefined).then(async () => {
      const receipt = await this.deliver({ ...snapshot, messageId: pending.notice.messageId });
      pending.notice.messageId = receipt.messageId;
    });
    pending.delivery = work;
    return work;
  }

  private settle(pending: PendingQuestion, status: "completed" | "cancelled" | "expired" | "failed", message: string,
    result: UserQuestionResult, error?: unknown): void {
    clearTimeout(pending.timer);
    if (pending.onAbort) pending.signal?.removeEventListener("abort", pending.onAbort);
    pending.notice.status = status; pending.notice.statusMessage = message;
    pending.timer = setTimeout(() => this.requests.delete(pending.notice.id), this.ttlMs);
    pending.timer.unref();
    if (error) pending.reject(error); else pending.resolve(result);
  }

  async ask(request: UserQuestionRequest, scope: UserQuestionScope): Promise<UserQuestionResult> {
    if (this.closed) throw new Error("User questions are closed");
    scope.signal?.throwIfAborted();
    const parsed = userQuestionRequestSchema.safeParse(request);
    if (!parsed.success) throw new Error("Invalid question form");
    let resolve!: PendingQuestion["resolve"], reject!: PendingQuestion["reject"];
    const result = new Promise<UserQuestionResult>((accept, fail) => { resolve = accept; reject = fail; });
    // A cancellation may arrive while the initial transport send is still pending.
    void result.catch(() => undefined);
    const id = randomUUID();
    const pending: PendingQuestion = { notice: { id, userId: scope.userId, conversationId: scope.conversationId,
      sessionId: scope.sessionId, questions: parsed.data.questions, purpose: parsed.data.purpose, status: "pending", expiresAt: Date.now() + this.ttlMs,
      statusMessage: parsed.data.purpose === "workspace" ? "请选择项目区。" : "请补充这些信息，我会根据你的回答继续。" }, resolve, reject,
      timer: setTimeout(() => {
        if (pending.notice.status !== "pending") return;
        this.settle(pending, "expired", "问题已过期；需要时请重新提出。", { status: "expired" });
        void this.publish(pending).catch(() => undefined);
      }, this.ttlMs), signal: scope.signal, delivery: Promise.resolve() };
    pending.timer.unref();
    pending.onAbort = () => {
      if (pending.notice.status !== "pending") return;
      pending.notice.resumeAfterRestart = scope.signal?.reason instanceof Error && scope.signal.reason.message === "Service stopping";
      this.settle(pending, "failed", "当前请求已结束，此问题不再接收回答。", { status: "cancelled" },
        scope.signal?.reason ?? new DOMException("Question cancelled", "AbortError"));
      void this.publish(pending).catch(() => undefined);
    };
    this.requests.set(id, pending);
    scope.signal?.addEventListener("abort", pending.onAbort, { once: true });
    // The transport may still be sending when a newer user message aborts this tool.
    // Wait on the checkpoint itself so cancellation can immediately release the conversation queue.
    void this.publish(pending).catch(() => {
      if (pending.notice.status === "pending") {
        clearTimeout(pending.timer);
        if (pending.onAbort) scope.signal?.removeEventListener("abort", pending.onAbort);
        this.requests.delete(id); pending.reject(new Error("Question delivery failed; no answer was received"));
      }
    });
    return result;
  }

  async act(userId: string, conversationId: string, action: UserQuestionAction): Promise<{ ok: boolean; message: string }> {
    const pending = this.requests.get(action.requestId);
    if (!pending || pending.notice.userId !== userId || pending.notice.conversationId !== conversationId)
      return { ok: false, message: "此问题已失效或不属于当前对话。" };
    if (pending.inFlight) return { ok: false, message: "正在接收回答，请稍候。" };
    if (pending.notice.status !== "pending") {
      void this.publish(pending).catch(() => undefined);
      return { ok: pending.notice.status === "completed" || pending.notice.status === "cancelled", message: pending.notice.statusMessage };
    }
    if (pending.notice.expiresAt <= Date.now()) {
      this.settle(pending, "expired", "问题已过期；需要时请重新提出。", { status: "expired" });
      void this.publish(pending).catch(() => undefined);
      return { ok: false, message: pending.notice.statusMessage };
    }
    if (action.cancel !== undefined && typeof action.cancel !== "boolean") return { ok: false, message: "问题操作无效。" };
    let answers: UserQuestionAnswers | undefined;
    if (!action.cancel) {
      answers = validateUserQuestionAnswers(pending.notice.questions, action.answers);
      if (!answers) return { ok: false, message: "请完整回答每个问题，并检查选项或填写内容。" };
    }
    pending.inFlight = true;
    try {
      if (action.cancel) this.settle(pending, "cancelled", pending.notice.purpose === "workspace" ? "项目区尚未选定，文件工作未开始。" : "已跳过这些问题，我会按现有信息继续。", { status: "cancelled" });
      else {
        pending.notice.answers = answers;
        const resultAnswers: NonNullable<UserQuestionResult["answers"]> = Object.fromEntries(pending.notice.questions.map(item => {
          const answer = answers![item.id]!, ids = answer.selectedOptionIds ?? [];
          return [item.id, { question: item.question, selectedOptionIds: ids,
            selectedOptions: item.type === "text" ? [] : item.options.filter(entry => ids.includes(entry.id)).map(entry => entry.label),
            ...(answer.text ? { text: answer.text } : {}) }];
        }));
        this.settle(pending, "completed", pending.notice.purpose === "workspace" ? "项目选择已收到。" : "回答已收到，我会继续处理。", { status: "answered", answers: resultAnswers });
      }
      // Acknowledging a card callback must not wait for another network request.
      // The serialized publication chain still patches this original card and supports retries.
      void this.publish(pending).catch(() => undefined);
      return { ok: true, message: pending.notice.statusMessage };
    } finally { pending.inFlight = false; }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const pending of this.requests.values()) {
      if (pending.notice.status === "pending") {
        pending.notice.resumeAfterRestart = true;
        this.settle(pending, "failed", "服务正在更新，请稍后提交回答。", { status: "cancelled" },
          new DOMException("Service stopping", "AbortError"));
        void this.publish(pending).catch(() => undefined);
      }
      clearTimeout(pending.timer);
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.requests.values()].map(pending => pending.delivery)),
      new Promise<void>(resolve => { timer = setTimeout(resolve, CLOSE_DELIVERY_WAIT_MS); })
    ]);
    if (timer) clearTimeout(timer);
    // Queued publications retain their record: if the first receipt arrives after close,
    // the interrupted snapshot is still patched onto that same delivered message.
    this.requests.clear();
  }
}

/** Validate the complete form before accepting any answer; clients cannot create questions or choices. */
export function validateUserQuestionAnswers(questions: UserQuestion[], input: unknown): UserQuestionAnswers | undefined {
  const parsed = userQuestionAnswersSchema.safeParse(input);
  if (!parsed.success || Object.keys(parsed.data).length !== questions.length) return;
  const answers: UserQuestionAnswers = {};
  for (const item of questions) {
    const answer = parsed.data[item.id];
    if (!answer) return;
    const selected = answer.selectedOptionIds ?? [], text = answer.text?.trim();
    if (new Set(selected).size !== selected.length) return;
    if (item.type === "text") { if (selected.length || !text) return; }
    else {
      if (selected.some(id => !item.options.some(entry => entry.id === id))) return;
      if (text && !item.allowOther || selected.length === 0 && !text) return;
      if (item.type === "single_select" && selected.length + (text ? 1 : 0) !== 1) return;
    }
    answers[item.id] = { ...(selected.length ? { selectedOptionIds: selected } : {}), ...(text ? { text } : {}) };
  }
  return answers;
}
