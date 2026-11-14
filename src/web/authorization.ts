import { randomUUID } from "node:crypto";
import type { WebCommunicationAdapter } from "./adapter.js";
import { authorizationInteraction, authorizationSetupRequiredText, type WebAuthorizationService } from "./interactions.js";
import { authorizationFailureText, type AuthorizationFailure } from "../productivity/authorization-failure.js";
import type { FeishuAuthorizationOptions, FeishuAuthorizationPrompt } from "../productivity/feishu-authorization-protocol.js";
import type { FeishuReadAuthorization } from "../tools/tool-contracts.js";

type Prompt = FeishuAuthorizationPrompt;
export type WebAuthorizationStarter = {
  available: boolean;
  cancel?(): void;
  start(send: (prompt: Prompt) => Promise<void>, notify: (outcome: "authorized" | "failed", failure?: AuthorizationFailure) => Promise<void>, options?: FeishuAuthorizationOptions): void;
};
type Card = { messageId: string; interactionId: string };
type Target = Card & { read?: FeishuReadAuthorization & { signal?: AbortSignal } };
type Outcome = { authorized: boolean; verifiedReads?: Set<string> };
type Attempt = {
  revision: string;
  targets: Map<string, Target>;
  options?: FeishuAuthorizationOptions;
  prompt?: Prompt;
  choice?: { message: string; expiresAt: number; timer: NodeJS.Timeout; retryRead?: () => void };
  completion: Promise<Outcome>;
  settle: (outcome: Outcome) => void;
};

/** Only standalone connection commands bypass the model; never consume a content request. */
export function isNotionAuthorizationRequest(text: string, previousService?: WebAuthorizationService): boolean {
  const value = text.trim().toLowerCase().replace(/[\s，。！？、,.!?：:]/g, "");
  if (!value.includes("notion") && previousService !== "notion") return false;
  const command = value.replace(/notion/g, "").replace(/^(?:请帮我|请|麻烦|帮我|给我)/, "");
  return /^(?:重新|再|再次)?(?:连接|授权|登录)(?:一下|一次)?(?:账号|账户)?(?:吧|了)?$/.test(command)
    || /^(?:重新|再|再次)?(?:弹出|弹|出|发出|发|显示|生成)(?:一下|一次|一张|一个)?(?:授权|连接|登录)(?:卡片|卡|入口|链接)(?:吧|了)?$/.test(command);
}

export function isFeishuAuthorizationRequest(text: string, previousService?: WebAuthorizationService): boolean {
  const value = text.trim().toLowerCase().replace(/[\s，。！？、,.!?：:]/g, "");
  if (!/飞书|feishu/.test(value) && previousService !== "feishu") return false;
  const command = value.replace(/飞书|feishu/g, "").replace(/^(?:请帮我|请|麻烦|帮我|给我)/, "");
  return /^(?:重新|再|再次)?(?:连接|授权|登录|发起)(?:一下|一次)?(?:账号|账户|授权)?(?:吧|了)?$/.test(command)
    || /^(?:切换|更换|换)(?:账号|账户|团队|应用)(?:吧|了)?$/.test(command);
}

/** Keeps OAuth and the original read bound to their originating conversations. */
export class WebAuthorizationInteractions {
  private readonly active = new Map<WebAuthorizationService, Attempt>();
  private closed = false;
  constructor(private readonly communication: WebCommunicationAdapter,
    private readonly starters: Partial<Record<WebAuthorizationService, WebAuthorizationStarter>>) {}

  start(service: WebAuthorizationService, conversationId: string): boolean {
    return Boolean(this.begin(service, conversationId));
  }

  /** Share attempts within one tool context, including failures, without sharing caller cancellation. */
  turnWaiter(conversationId: string): (service: WebAuthorizationService, signal?: AbortSignal) => Promise<void> {
    const attempts = new Map<WebAuthorizationService, Attempt | undefined>();
    return async (service, signal) => {
      signal?.throwIfAborted();
      if (!attempts.has(service)) attempts.set(service, this.begin(service, conversationId));
      const attempt = attempts.get(service);
      await this.waitForAttempt(service, conversationId, attempt, signal);
      if (attempts.get(service) === attempt) attempts.delete(service);
    };
  }

  async wait(service: WebAuthorizationService, conversationId: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.waitForAttempt(service, conversationId, this.begin(service, conversationId), signal);
  }

  async waitForFeishuRead(conversationId: string, read: FeishuReadAuthorization, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const attempt = this.begin("feishu", conversationId, undefined, { repairAppId: read.repairAppId }, undefined, { ...read, signal });
    try { await this.waitForAttempt("feishu", conversationId, attempt, signal, true); }
    finally {
      const current = this.active.get("feishu");
      if (signal?.aborted && current?.choice && ![...current.targets.values()].some(target => target.read && !target.read.signal?.aborted)) {
        clearTimeout(current.choice.timer);
        this.active.delete("feishu");
        current.settle({ authorized: false });
        for (const [target, card] of current.targets) this.communication.interaction(target,
          authorizationInteraction(card.interactionId, "feishu", "cancelled", undefined, "读取已停止。"), card.messageId);
      }
    }
  }

  private async waitForAttempt(service: WebAuthorizationService, conversationId: string, attempt: Attempt | undefined,
    signal?: AbortSignal, requireVerifiedRead = false): Promise<void> {
    if (!attempt) throw new Error(authorizationSetupRequiredText(service));
    await new Promise<void>((resolve, reject) => {
      const aborted = () => { signal?.removeEventListener("abort", aborted); reject(signal?.reason); };
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
      void attempt.completion.then(outcome => {
        signal?.removeEventListener("abort", aborted);
        if (outcome.authorized && (!requireVerifiedRead || outcome.verifiedReads?.has(conversationId))) resolve();
        else reject(new Error("账号授权或读取未完成，请查看操作卡片。"));
      });
    });
    signal?.throwIfAborted();
  }

  private begin(service: WebAuthorizationService, conversationId: string, reuse?: Card, options?: FeishuAuthorizationOptions,
    inherited?: Attempt, read?: Target["read"]): Attempt | undefined {
    if (this.closed) return;
    const starter = this.starters[service];
    const existing = this.active.get(service);
    if (existing) {
      const previous = existing.targets.get(conversationId);
      if (service !== "feishu" && reuse && previous && previous.messageId !== reuse.messageId) this.communication.interaction(conversationId,
        authorizationInteraction(previous.interactionId, service, "cancelled", undefined, "已重新显示连接入口。"), previous.messageId);
      const card = (service === "feishu" ? previous ?? reuse : reuse ?? previous) ?? { messageId: randomUUID(), interactionId: randomUUID() };
      existing.targets.set(conversationId, { ...card, ...(read ? { read } : {}) });
      this.publish(service, existing);
      return existing;
    }
    const previous = inherited?.targets.get(conversationId);
    const card = reuse ?? previous ?? { messageId: randomUUID(), interactionId: randomUUID() };
    if (!starter?.available) {
      this.communication.interaction(conversationId, authorizationInteraction(card.interactionId, service, "failed", undefined,
        authorizationSetupRequiredText(service)), card.messageId);
      return;
    }
    const priorFailure = service === "feishu" && this.communication.store.feishuAuthorizationStatus();
    if (priorFailure && !read) {
      const previous = this.communication.store.messages(conversationId, Number.MAX_SAFE_INTEGER, 100, true).some(message =>
        message.interactions?.some(item => item.kind === "authorization" && item.service === service && item.status === priorFailure));
      if (!previous) this.communication.interaction(conversationId, authorizationInteraction(card.interactionId, service, priorFailure), card.messageId);
      return;
    }
    let settle!: Attempt["settle"];
    const completion = new Promise<Outcome>(resolve => { settle = resolve; });
    const attempt: Attempt = { revision: randomUUID(), targets: new Map(inherited?.targets), options, completion, settle };
    // A retry supplies the persisted card identity. The suspended read belongs to the live target.
    attempt.targets.set(conversationId, { ...card, read: read ?? previous?.read });
    this.active.set(service, attempt);
    const finish = async (outcome: "authorized" | "failed", failure?: AuthorizationFailure) => {
      if (this.closed || this.active.get(service) !== attempt) return;
      this.active.delete(service);
      if (attempt.choice) clearTimeout(attempt.choice.timer);
      const authorized = outcome === "authorized";
      const verifiedReads = new Set<string>();
      const status = authorized ? "completed" : attempt.choice || (attempt.prompt?.expiresAt ?? Infinity) <= Date.now()
        || failure?.reason === "expired" ? "expired" : "failed";
      try {
        if (service === "feishu" && !attempt.choice) this.communication.store.setFeishuAuthorizationStatus(
          status === "completed" ? undefined : status);
        await Promise.allSettled([...attempt.targets].map(async ([target, entry]) => {
          const update = (state: "pending" | "completed" | "failed" | "expired", message?: string, busy = false) =>
            this.communication.interaction(target, authorizationInteraction(entry.interactionId, service, state,
              undefined, message, { revision: attempt.revision, busy }), entry.messageId);
          if (!authorized || !entry.read) { update(status, failure ? authorizationFailureText(failure) : undefined); return; }
          update("pending", attempt.choice ? "正在重试原读取…" : "账号已连接，正在重试原读取…", true);
          let reason: string | undefined;
          try { if (!entry.read.signal?.aborted) reason = await entry.read.verify(); }
          catch { reason = "飞书读取未完成，请稍后重新发起读取。"; }
          if (this.closed) return;
          if (entry.read.signal?.aborted) { update("completed", "本次读取已停止。"); return; }
          if (reason) update("failed", reason);
          else {
            update("completed", "原读取已成功，继续处理。");
            verifiedReads.add(target);
          }
        }));
      } finally { attempt.settle({ authorized, verifiedReads }); }
    };
    const choiceMessage = read?.chooseAccount || (priorFailure ? "上次飞书授权未完成，请重新连接。" : undefined);
    if (choiceMessage) {
      const lifetime = 10 * 60_000;
      const timer = setTimeout(() => { void finish("failed").catch(() => console.warn("Unable to expire Feishu connection card")); }, lifetime);
      timer.unref();
      attempt.choice = { message: choiceMessage, expiresAt: Date.now() + lifetime, timer,
        ...(read?.chooseAccount ? { retryRead: () => { void finish("authorized").catch(() => console.warn("Unable to retry Feishu read")); } } : {}) };
      this.publish(service, attempt);
      return attempt;
    }
    this.publish(service, attempt);
    try {
      starter.start(async prompt => {
        if (this.closed || this.active.get(service) !== attempt) return;
        authorizationInteraction(card.interactionId, service, "pending", prompt);
        attempt.prompt = prompt;
        this.publish(service, attempt);
      }, finish, options);
    } catch { void finish("failed").catch(() => console.warn("Unable to finish account connection card")); }
    return attempt;
  }

  retry(service: WebAuthorizationService, conversationId: string, messageId: string, interactionId: string, switchAccount = false): boolean {
    if (service !== "feishu") return Boolean(this.begin(service, conversationId, { messageId, interactionId }));
    return this.restartFeishu(conversationId, switchAccount, { messageId, interactionId });
  }

  private restartFeishu(conversationId: string, switchAccount: boolean, reuse?: Card): boolean {
    const service = "feishu", previous = this.active.get(service);
    const current = previous?.targets.get(conversationId);
    // Late clicks on an older card cannot move or replace a live attempt.
    if (reuse && current && (current.messageId !== reuse.messageId || current.interactionId !== reuse.interactionId)) return true;
    if (reuse && !switchAccount && previous?.choice?.retryRead && previous.choice.expiresAt > Date.now()) {
      previous.choice.retryRead();
      return true;
    }
    if (previous && !previous.choice && (previous.prompt?.expiresAt ?? Infinity) > Date.now()
      && (!switchAccount || previous.options?.switchAccount)) {
      this.begin(service, conversationId, reuse);
      return true;
    }
    if (previous?.choice) clearTimeout(previous.choice.timer);
    this.starters.feishu?.cancel?.();
    this.communication.store.setFeishuAuthorizationStatus();
    this.active.delete(service);
    const next = this.begin(service, conversationId, reuse, {
      switchAccount, repairAppId: switchAccount ? undefined : previous?.options?.repairAppId
    }, previous);
    if (previous) {
      if (next) void next.completion.then(previous.settle);
      else previous.settle({ authorized: false });
    }
    return Boolean(next);
  }

  redisplay(service: WebAuthorizationService, conversationId: string, switchAccount = false): boolean {
    if (service === "feishu") return this.restartFeishu(conversationId, switchAccount);
    const attempt = this.active.get(service), previous = attempt?.targets.get(conversationId);
    if (attempt && previous) {
      this.communication.interaction(conversationId, authorizationInteraction(previous.interactionId, service,
        "cancelled", undefined, "已重新显示连接入口。"), previous.messageId);
      attempt.targets.delete(conversationId);
    }
    return this.start(service, conversationId);
  }

  private publish(service: WebAuthorizationService, attempt: Attempt): void {
    for (const [target, card] of attempt.targets) this.communication.interaction(target, authorizationInteraction(
      card.interactionId, service, "pending", attempt.prompt, attempt.choice?.message, {
        revision: attempt.revision, choosing: attempt.options?.switchAccount, choiceExpiresAt: attempt.choice?.expiresAt,
        retryRead: Boolean(card.read?.chooseAccount)
      }), card.messageId);
  }

  close(): void {
    this.closed = true;
    for (const [service, attempt] of this.active) {
      if (attempt.choice) clearTimeout(attempt.choice.timer);
      this.starters[service]?.cancel?.();
      attempt.settle({ authorized: false });
    }
    this.active.clear();
  }
}
