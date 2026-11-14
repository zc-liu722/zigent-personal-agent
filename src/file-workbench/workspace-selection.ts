import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { prepareSql, sqliteTransaction } from "../sqlite.js";
import type { ToolExecutionContext } from "../tools/tool-contracts.js";
import type { Workspace, WorkspaceService } from "../workspaces/service.js";

export type WorkspaceChoice = {
  workspaceId?: string; name?: string; purpose: string; reason: string;
  confidence: "clear" | "uncertain";
};
type Selection = { status: "selected" | "pending" | "unresolved" | "unselected"; workspaceId?: string;
  purpose?: string; reason?: string; source?: "automatic" | "user"; revision?: string; updatedAt: number };

/** Project selection supplies the default target for otherwise unqualified operations. */
export class WorkspaceSelection {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(private readonly db: DatabaseSync, private readonly files: WorkspaceService,
    private readonly assertExecutable: (id: string) => void) {}

  private read(key: string): string | undefined {
    return (prepareSql(this.db, "SELECT value FROM preferences WHERE key=?").get(key) as { value: string } | undefined)?.value;
  }
  private write(key: string, value: unknown) {
    prepareSql(this.db, "INSERT OR REPLACE INTO preferences VALUES (?,?)").run(key, JSON.stringify(value));
  }
  state(sessionId: string): Selection | undefined {
    const saved = this.read("workspace-selection:" + sessionId);
    if (saved) {
      const state = JSON.parse(saved) as Selection;
      if (state.status === "selected" && state.workspaceId) {
        try { this.files.assertSessionAccess(state.workspaceId, sessionId); }
        catch { return { status: "unselected", updatedAt: Date.now() }; }
      }
      return state;
    }
    // Existing explicit session choices survive the upgrade; the implicit default does not.
    const workspaceId = this.read("session:" + sessionId);
    if (!workspaceId) return undefined;
    try { this.files.assertSessionAccess(workspaceId, sessionId); } catch { return { status: "unselected", updatedAt: Date.now() }; }
    return { status: "selected", workspaceId, updatedAt: 0 };
  }
  currentProject(sessionId: string): string | undefined {
    const selection = this.state(sessionId);
    if (selection?.status !== "selected" || !selection.workspaceId) return undefined;
    if (this.files.workspace(selection.workspaceId).lifetime === "persistent") return selection.workspaceId;
  }
  historicalDirectory(sessionId: string): string | undefined {
    const selection = this.state(sessionId);
    for (const id of [selection?.status === "selected" ? selection.workspaceId : undefined, this.read("historical-directory:" + sessionId)]) {
      if (!id) continue;
      try {
        this.files.assertSessionAccess(id, sessionId);
        const kind = this.files.workspace(id).lifetime;
        if (kind === "temporary" || kind === "legacy") return id;
      } catch { /* A previous release may already have reclaimed it. */ }
    }
    return undefined;
  }
  private rememberHistoricalDirectory(sessionId: string) {
    const id = this.historicalDirectory(sessionId);
    if (id) prepareSql(this.db, "INSERT OR REPLACE INTO preferences VALUES (?,?)").run("historical-directory:" + sessionId, id);
  }
  list() {
    return this.files.listWorkspaces().map(workspace => ({ ...workspace,
      purpose: this.read("workspace-purpose:" + workspace.id),
      recentFiles: this.files.listArtifacts(workspace.id, "artifact", 0, 3).map(file => ({ name: file.name, title: file.title })) }));
  }
  select(sessionId: string, id: string, detail: { purpose?: string; reason?: string; source: "automatic" | "user" }) {
    this.files.assertPersistentProject(id);
    const workspace = this.files.workspace(id); this.assertExecutable(id);
    sqliteTransaction(this.db, () => {
      this.rememberHistoricalDirectory(sessionId);
      prepareSql(this.db, "DELETE FROM preferences WHERE key=?").run("workspace-unresolved:" + sessionId);
      prepareSql(this.db, "INSERT OR REPLACE INTO preferences VALUES (?,?)").run("session:" + sessionId, id);
      this.write("workspace-selection:" + sessionId, { status: "selected", workspaceId: id, ...detail, revision: randomUUID(), updatedAt: Date.now() });
      if (detail.purpose) prepareSql(this.db, "INSERT OR REPLACE INTO preferences VALUES (?,?)").run("workspace-purpose:" + id, detail.purpose);
    });
    return workspace;
  }
  exit(context: ToolExecutionContext) {
    if (context.subagent) throw new Error("请由主 Agent 退出项目区。");
    sqliteTransaction(this.db, () => {
      this.rememberHistoricalDirectory(context.sessionId);
      prepareSql(this.db, "DELETE FROM preferences WHERE key=?").run("workspace-unresolved:" + context.sessionId);
      prepareSql(this.db, "DELETE FROM preferences WHERE key=?").run("session:" + context.sessionId);
      this.write("workspace-selection:" + context.sessionId, { status: "unselected", revision: randomUUID(), updatedAt: Date.now() });
    });
    return { status: "unselected", selection: this.state(context.sessionId), message: "已退出项目区。" };
  }
  assertUnambiguous(sessionId: string, turnId: number) {
    if (this.pending.has(sessionId) || this.read("workspace-unresolved:" + sessionId) === String(turnId))
      throw new Error("项目归属仍待确认。请指定目标项目，或退出项目选择后处理会话文件。");
  }
  async resolve(choice: WorkspaceChoice, context: ToolExecutionContext) {
    if (context.subagent) throw new Error("请由主 Agent 选择项目区，并向子任务提供明确的环境编号。");
    if (this.pending.has(context.sessionId)) throw new Error("项目区选择正在处理，请等待原选择完成。");
    if (Boolean(choice.workspaceId) === Boolean(choice.name)) throw new Error("请选择已有项目区编号或新项目名称，两者只能提供一个。");
    const purpose = choice.purpose.trim(), reason = choice.reason.trim(), name = choice.name?.trim();
    if (!purpose || purpose.length > 500 || !reason || reason.length > 500 || choice.name !== undefined && !name || name && (name.length > 160 || /[\x00-\x1f\x7f]/.test(name)))
      throw new Error("请提供有效的任务用途、选择依据和项目名称。");
    if (choice.workspaceId) { this.files.assertPersistentProject(choice.workspaceId); this.assertExecutable(choice.workspaceId); }
    const work = this.resolveChoice({ ...choice, name, purpose, reason }, context);
    this.pending.set(context.sessionId, work);
    try { return await work; } finally { this.pending.delete(context.sessionId); }
  }
  private async resolveChoice(choice: WorkspaceChoice, context: ToolExecutionContext) {
    const key = "workspace-choice:" + context.sessionId + ":" + context.turnId + ":" + createHash("sha256").update(JSON.stringify(choice)).digest("hex");
    const prior = this.read(key);
    if (prior && this.state(context.sessionId)?.status === "selected" && this.state(context.sessionId)?.workspaceId === prior)
      return this.result(this.files.workspace(prior), context.sessionId, this.read(key + ":created") === prior);
    let workspaceId = choice.workspaceId, name = choice.name, source: "automatic" | "user" = "automatic";
    if (choice.confidence === "uncertain") {
      this.rememberHistoricalDirectory(context.sessionId);
      this.write("workspace-unresolved:" + context.sessionId, context.turnId);
      const retained = Boolean(this.currentProject(context.sessionId));
      if (!context.askUserQuestion) {
        if (!retained) this.write("workspace-selection:" + context.sessionId, { status: "unresolved", purpose: choice.purpose, updatedAt: Date.now() });
        throw new Error("当前无法展示项目区选择，请在网页对话中继续；尚未创建或切换项目区。");
      }
      const revision = randomUUID();
      // A proposed switch must not erase the session's chosen project, including on restart.
      if (!retained) this.write("workspace-selection:" + context.sessionId, { status: "pending", purpose: choice.purpose, reason: choice.reason, revision, updatedAt: Date.now() });
      const expected = this.read("workspace-selection:" + context.sessionId);
      const recommended = workspaceId ? this.files.workspace(workspaceId) : undefined;
      const suggestedName = name ?? choice.purpose.slice(0, 80).replace(/[\x00-\x1f\x7f]/g, " ");
      const newLabel = "新建项目：";
      const options = [
        { id: workspaceId ?? "create", label: `${recommended ? recommended.name : newLabel + suggestedName}`.slice(0, 90) + "（推荐）", description: choice.reason },
        ...this.list().filter(workspace => workspace.id !== workspaceId).slice(0, (workspaceId ? 2 : 3) - (retained ? 1 : 0))
          .map(workspace => ({ id: workspace.id, label: workspace.name.slice(0, 100), description: (workspace.purpose ?? `在“${workspace.name}”中继续工作。`).slice(0, 500) })),

        ...(retained ? [{ id: "exit", label: "退出项目区", description: "清除当前项目选择。" }] : [])
      ];
      if (options.length === 1) options.push({ id: "cancel", label: "暂不开始", description: "先明确项目归属。" });
      try {
        const result = await context.askUserQuestion({ purpose: "workspace", questions: [{ id: "workspace", header: "选择项目区", type: "single_select", allowOther: true,
          question: choice.purpose, options }] });
        context.signal?.throwIfAborted();
        if (this.read("workspace-selection:" + context.sessionId) !== expected)
          return { status: "superseded", message: "项目区选择已更新，请读取当前选择后继续，不要应用旧选项。" };
        const answer = result.answers?.workspace, selected = answer?.selectedOptionIds;
        if (result.status !== "answered" || answer?.text || selected?.length !== 1 || selected[0] === "cancel") {
          if (!retained) this.write("workspace-selection:" + context.sessionId, { status: "unresolved", purpose: choice.purpose, updatedAt: Date.now() });
          return { status: answer?.text ? "needs_clarification" : result.status === "answered" ? "cancelled" : result.status,
            selection: this.state(context.sessionId),
            ...(answer?.text ? { userPreference: answer.text } : {}), message: retained
              ? "项目区未切换，原会话选择保留。请按用户补充继续澄清，不要将跳过视为新任务的项目授权。"
              : "尚未选定项目区，请按用户补充继续澄清；不要开始文件工作或将跳过视为授权。" };
        }
        if (!options.some(option => option.id === selected[0])) throw new Error("项目区选项已失效。");
        if (selected[0] === "exit") return this.exit(context);
        workspaceId = selected[0] === "create" ? undefined : selected[0]; name = suggestedName; source = "user";
      } catch (error) {
        if (!retained && this.read("workspace-selection:" + context.sessionId) === expected)
          this.write("workspace-selection:" + context.sessionId, { status: "unresolved", purpose: choice.purpose, updatedAt: Date.now() });
        throw error;
      }
    }
    context.signal?.throwIfAborted();
    const expectedSelection = this.read("workspace-selection:" + context.sessionId);
    const created = this.read(key + ":created");
    const workspace = workspaceId ? this.files.workspace(workspaceId) : created ? this.files.workspace(created)
      : await this.files.createWorkspace({ name: name!, lifetime: "persistent" });
    if (!workspaceId) prepareSql(this.db, "INSERT OR REPLACE INTO preferences VALUES (?,?)").run(key + ":created", workspace.id);
    // Remember a newly created project before yielding, so retries never create another copy.
    prepareSql(this.db, "INSERT OR REPLACE INTO preferences VALUES (?,?)").run(key, workspace.id);
    context.signal?.throwIfAborted();
    if (this.read("workspace-selection:" + context.sessionId) !== expectedSelection)
      return { status: "superseded", message: "项目区选择已更新，请读取当前选择后继续，不要应用旧选项。" };
    this.select(context.sessionId, workspace.id, { purpose: choice.purpose, reason: choice.reason, source });
    return this.result(workspace, context.sessionId, !workspaceId);
  }
  private result(workspace: Workspace, sessionId: string, created: boolean) {
    return { status: "selected", created, workspace, environment_id: workspace.id, selection: this.state(sessionId) };
  }
}
