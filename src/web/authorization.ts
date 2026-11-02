import { randomUUID } from "node:crypto";
import type { WebCommunicationAdapter } from "./adapter.js";
import { authorizationInteraction, authorizationSetupRequiredText, type WebAuthorizationService } from "./interactions.js";
import { authorizationFailureText, type AuthorizationFailure } from "../productivity/authorization-failure.js";

type Prompt = { authorizationUrl: string; expiresAt: number };
export type WebAuthorizationStarter = {
  available: boolean;
  start(send: (prompt: Prompt) => Promise<void>, notify: (outcome: "authorized" | "failed", failure?: AuthorizationFailure) => Promise<void>): void;
};
type Attempt = { id: string; targets: Map<string, string>; prompt?: Prompt;
  completion: Promise<boolean>; settle: (authorized: boolean) => void };

/** Only standalone connection commands bypass the model; never consume a content request. */
export function isNotionAuthorizationRequest(text: string, previousService?: WebAuthorizationService): boolean {
  const value = text.trim().toLowerCase().replace(/[\s，。！？、,.!?：:]/g, "");
  if (!value.includes("notion") && previousService !== "notion") return false;
  const command = value.replace(/notion/g, "").replace(/^(?:请帮我|请|麻烦|帮我|给我)/, "");
  return /^(?:重新|再|再次)?(?:连接|授权|登录)(?:一下|一次)?(?:账号|账户)?(?:吧|了)?$/.test(command)
    || /^(?:重新|再|再次)?(?:弹出|弹|出|发出|发|显示|生成)(?:一下|一次|一张|一个)?(?:授权|连接|登录)(?:卡片|卡|入口|链接)(?:吧|了)?$/.test(command);
}

/** Keeps OAuth UI bound to the originating sessions, independently of later model turns. */
export class WebAuthorizationInteractions {
  private readonly active = new Map<WebAuthorizationService, Attempt>();
  private closed = false;
  constructor(private readonly communication: WebCommunicationAdapter,
    private readonly starters: Partial<Record<WebAuthorizationService, WebAuthorizationStarter>>) {}

  start(service: WebAuthorizationService, conversationId: string, reuse?: { messageId: string; interactionId: string }): boolean {
    return Boolean(this.begin(service, conversationId, reuse));
  }

  /** Bind before starting OAuth so even a fast callback resumes the exact waiting call. */
  async wait(service: WebAuthorizationService, conversationId: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const attempt = this.begin(service, conversationId);
    if (!attempt) throw new Error(authorizationSetupRequiredText(service));
    await new Promise<void>((resolve, reject) => {
      const aborted = () => { signal?.removeEventListener("abort", aborted); reject(signal?.reason); };
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
      void attempt.completion.then(authorized => {
        signal?.removeEventListener("abort", aborted);
        if (authorized) resolve();
        else reject(new Error("账号授权未完成，操作已停止。请重新连接后重试。"));
      });
    });
    signal?.throwIfAborted();
  }

  private begin(service: WebAuthorizationService, conversationId: string, reuse?: { messageId: string; interactionId: string }): Attempt | undefined {
    if (this.closed) return;
    const starter = this.starters[service];
    if (!starter?.available) {
      const interaction = authorizationInteraction(reuse?.interactionId ?? randomUUID(), service, "failed", undefined,
        authorizationSetupRequiredText(service));
      this.communication.interaction(conversationId, interaction, reuse?.messageId);
      return;
    }
    const existing = this.active.get(service);
    if (existing) {
      const previous = existing.targets.get(conversationId);
      if (reuse && previous && previous !== reuse.messageId) this.communication.interaction(conversationId,
        authorizationInteraction(existing.id, service, "cancelled", undefined, "已重新显示连接入口。"), previous);
      if (reuse || !previous) existing.targets.set(conversationId, reuse?.messageId ?? randomUUID());
      this.publish(service, existing);
      return existing;
    }
    let settle!: Attempt["settle"];
    const completion = new Promise<boolean>(resolve => { settle = resolve; });
    const attempt: Attempt = { id: reuse?.interactionId ?? randomUUID(), targets: new Map([[conversationId, reuse?.messageId ?? randomUUID()]]), completion, settle };
    this.active.set(service, attempt);
    this.publish(service, attempt);
    const finish = async (outcome: "authorized" | "failed", failure?: AuthorizationFailure) => {
      if (this.closed || this.active.get(service) !== attempt) return;
      this.active.delete(service);
      const status = outcome === "authorized" ? "completed" : attempt.prompt && attempt.prompt.expiresAt <= Date.now() ? "expired" : "failed";
      try {
        for (const [target, messageId] of attempt.targets) this.communication.interaction(target,
          authorizationInteraction(attempt.id, service, status, undefined, failure ? authorizationFailureText(failure) : undefined), messageId);
      } finally { attempt.settle(outcome === "authorized"); }
    };
    try {
      starter.start(async prompt => {
        if (this.closed || this.active.get(service) !== attempt) return;
        // Validate before storing: OAuth URLs remain in authenticated transport history only.
        authorizationInteraction(attempt.id, service, "pending", prompt);
        attempt.prompt = prompt;
        this.publish(service, attempt);
      }, finish);
    } catch { void finish("failed"); }
    return attempt;
  }

  retry(service: WebAuthorizationService, conversationId: string, messageId: string, interactionId: string): boolean {
    return this.start(service, conversationId, { messageId, interactionId });
  }

  redisplay(service: WebAuthorizationService, conversationId: string): boolean {
    const attempt = this.active.get(service), previous = attempt?.targets.get(conversationId);
    if (attempt && previous) {
      this.communication.interaction(conversationId,
        authorizationInteraction(attempt.id, service, "cancelled", undefined, "已重新显示连接入口。"), previous);
      attempt.targets.delete(conversationId);
    }
    return this.start(service, conversationId);
  }
  private publish(service: WebAuthorizationService, attempt: Attempt): void {
    for (const [target, messageId] of attempt.targets) this.communication.interaction(target,
      authorizationInteraction(attempt.id, service, "pending", attempt.prompt), messageId);
  }
  close(): void {
    this.closed = true;
    for (const attempt of this.active.values()) attempt.settle(false);
    this.active.clear();
  }
}
