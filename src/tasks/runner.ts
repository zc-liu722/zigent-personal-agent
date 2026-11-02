import { BackgroundScheduler, BackgroundWork, type ScheduledSource } from "../background-scheduler.js";
import { BackgroundDeliveryUncertainError } from "../channels/background-delivery.js";
import { AgentTranscript } from "../agent/transcript.js";
import type { AgentEventObserver } from "../agent/events.js";
import type { ActiveTask, TaskRun, TaskRunResult } from "./types.js";
import type { TaskStore } from "./store.js";
import type { PerformanceStore } from "../performance/store.js";
export type TaskRunnerOptions = {
  store: TaskStore;
  performance?: PerformanceStore;
  execute(input: {
    task: ActiveTask;
    run: TaskRun;
    signal: AbortSignal;
    onEvent: AgentEventObserver;
  }): Promise<TaskRunResult>;
  /** Must call beforeSend immediately before a first send; ambiguous retries reconcile their original UUID. */
  deliver(input: {
    task: ActiveTask;
    run: TaskRun;
    text: string;
    idempotencyKey: string;
    beforeSend: () => Promise<void>;
  }): Promise<{ sessionId: string; messageId: string }>;
  currentSkillRevision?(task: ActiveTask): Promise<number>;
  /** Poll arrival revisions / durable OwnTracks event IDs before collecting due tasks. */
  pollEvents?(store: TaskStore): Promise<void>;
  onError?(error: unknown): void;
  scheduler?: BackgroundScheduler;
  concurrency?: number;
  leaseMs?: number;
  timeoutMs?: number;
  maxAttempts?: number;
};
export class StaleTaskResultError extends Error {
  constructor() {
    super("Task result was superseded before delivery");
    this.name = "StaleTaskResultError";
  }
}
export class TaskRunner {
  private source?: ScheduledSource;
  private unsubscribe?: () => void;
  private collecting?: Promise<void>;
  private readonly work: BackgroundWork;
  private paused = false;
  private stopped = false;
  get activeCount(): number { return this.work.size + (this.collecting ? 1 : 0); }
  pause(value: boolean): void { this.paused = value; this.wake(); }
  wake(): void { this.source?.wake(); }
  constructor(private readonly options: TaskRunnerOptions) {
    this.work = new BackgroundWork(() => this.wake(), options.concurrency ?? 3);
  }
  start(): void {
    if (this.source || this.stopped) return;
    this.source = (this.options.scheduler ?? new BackgroundScheduler()).register(async () => {
      try { await this.tick(); } catch (error) { this.options.onError?.(error); throw error; }
      return this.paused || this.stopped ? undefined
        : this.options.store.nextWakeAt(this.work.keys, !this.work.full, this.options.maxAttempts ?? 3);
    });
    this.unsubscribe = this.options.store.onChange(() => this.wake());
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.source?.close(); this.unsubscribe?.();
    await this.collecting?.catch(() => {});
    await this.work.close();
  }
  tick(): Promise<void> {
    if (this.collecting) return this.collecting;
    if (this.paused || this.stopped) return Promise.resolve();
    this.collecting = this.dispatch().finally(() => { this.collecting = undefined; });
    return this.collecting;
  }
  private async dispatch(): Promise<void> {
    const { store } = this.options;
    await this.options.pollEvents?.(store);
    if (this.paused || this.stopped) return;
    store.collectDue();
    // Delivery has its own durable deadline and is serialized with other work on the same task.
    for (const pending of store.pendingNotifications()) {
      if (this.work.full) break;
      this.work.start(pending.taskId, () => this.deliver(pending));
    }
    while (!this.work.full) {
      const run = store.claim(this.options.leaseMs ?? 30000, Date.now(), this.options.maxAttempts ?? 3, this.work.keys);
      if (!run?.leaseToken) break;
      this.work.start(run.taskId, signal => this.execute(run, signal));
    }
  }
  private async execute(run: TaskRun, shutdown: AbortSignal): Promise<void> {
    const { store } = this.options;
    const task = store.get(run.taskId)!;
    const leaseMs = this.options.leaseMs ?? 30000, maxAttempts = this.options.maxAttempts ?? 3;
    const token = run.leaseToken!,
      controller = new AbortController();
    const signal = AbortSignal.any([shutdown, controller.signal]);
    const transcript = new AgentTranscript();
    let recording = true;
    let activityTimer: ReturnType<typeof setTimeout> | undefined;
    const saveActivity = () => {
      clearTimeout(activityTimer); activityTimer = undefined;
      store.saveActivity(run.id, token, run.attempts, transcript.snapshot());
    };
    saveActivity();
    const onEvent: AgentEventObserver = event => {
      if (!recording || signal.aborted) return;
      // Background model text is a structured delivery decision. The parsed
      // message is delivered separately; never render its JSON as chat prose.
      if (event.type === "response.delta" || event.type === "response.completed") return;
      transcript.advance(event);
      if (!activityTimer) { activityTimer = setTimeout(saveActivity, 200); activityTimer.unref(); }
    };
    const heartbeat = setInterval(
      () => {
        try {
          if (!store.heartbeat(run.id, token, leaseMs))
            controller.abort(
              new Error("Task cancelled or execution lease lost"),
            );
        } catch (e) {
          controller.abort(e);
        }
      },
      Math.max(10, Math.floor(leaseMs / 3)),
    );
    const deadline = setTimeout(
      () => controller.abort(new Error("Task execution timed out")),
      this.options.timeoutMs ?? 180000,
    );
    let rejectAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () =>
        reject(signal.reason ?? new Error("Task aborted"));
      signal.addEventListener("abort", rejectAbort, {
        once: true,
      });
    });
    try {
      const execute = () => Promise.race([
        this.options.execute({ task, run, signal, onEvent }),
        aborted,
      ]);
      signal.throwIfAborted();
      const result = await (this.options.performance ? this.options.performance.measure("task.execute", "background", execute) : execute());
      signal.throwIfAborted();
      transcript.complete(result.summary ?? "执行完成");
      saveActivity();
      store.complete(run.id, token, result);
    } catch (e) {
      transcript.fail("这次执行未完成。");
      saveActivity();
      store.fail(
        run.id,
        token,
        e instanceof Error ? e.message : "Task execution failed",
        maxAttempts,
      );
    } finally {
      recording = false; clearTimeout(activityTimer);
      clearInterval(heartbeat);
      clearTimeout(deadline);
      if (rejectAbort)
        signal.removeEventListener("abort", rejectAbort);
    }
  }
  private async deliver(pending: TaskRun): Promise<void> {
    const { store } = this.options;
    const task = store.get(pending.taskId);
    if (!task) {
      store.markStale(pending.id);
      return;
    }
    const beforeSend = async () => {
      if (this.stopped) throw new Error("Task delivery stopped");
      const current = store.get(task.id);
      if (
        current?.status !== "active" ||
        current.revision !== pending.taskRevision ||
        !store.isRunTriggerCurrent(current, pending)
      )
        throw new StaleTaskResultError();
      if (
        pending.result?.skillRevision !== undefined &&
        this.options.currentSkillRevision &&
        (await this.options.currentSkillRevision(current)) !==
          pending.result.skillRevision
      )
        throw new StaleTaskResultError();
    };
    try {
      const deliver = () => this.options.deliver({
        task,
        run: pending,
        text: pending.result!.text!,
        idempotencyKey: pending.notificationId,
        beforeSend,
      });
      const link = await (this.options.performance ? this.options.performance.measure("task.delivery", "background", deliver) : deliver());
      store.markDelivered(pending.id, link);
    } catch (e) {
      if (e instanceof StaleTaskResultError) store.refreshStale(pending.id);
      else if (e instanceof BackgroundDeliveryUncertainError)
        store.markNotificationUncertain(pending.id);
      else {
        store.deferNotification(pending.id, Date.now() + 30_000);
        this.options.onError?.(e);
      }
    }
  }
}
