import { z } from "zod";
import type { BrowserRestriction } from "./restrictions.js";

export type BrowserScope = { agentId: string; userId: string; conversationId?: string; conversationKind?: "p2p" | "group"; sessionId?: string; signal?: AbortSignal };
export type BrowserMode = "agent" | "user" | "paused" | "stopped";
export type BrowserNetwork = "direct" | "proxy";
export type BrowserPauseReason = "user" | "handoff" | "restart" | "disconnected" | "launch_failed" | "submission_cancelled" | "verification" | "restricted" | "navigation_loop" | "idle" | "unknown";
export type BrowserSession = { id: string; conversationId: string; sourceSessionId?: string; title: string; mode: BrowserMode; network?: BrowserNetwork; pauseReason?: BrowserPauseReason; restrictions?: BrowserRestriction[]; resumeOnUse?: boolean; revision: number; updatedAt: number; error?: string };
export function browserStateMessage(mode: BrowserMode, reason?: BrowserPauseReason): string {
  if (mode === "user" && reason === "verification") return "请完成安全验证";
  if (mode === "agent") return "Zigent 控制";
  if (mode === "user") return "用户已接管";
  if (mode === "stopped") return "浏览器已停止";
  return ({ user: "浏览器已手动暂停", handoff: "浏览器等待登录操作", restart: "服务重启后浏览器已暂停",
    idle: "浏览器空闲后已关闭", verification: "浏览器等待安全验证", restricted: "网站访问受限", navigation_loop: "网页反复跳转，已停止加载", disconnected: "浏览器断连后已暂停", launch_failed: "浏览器启动未完成", submission_cancelled: "取消提交后浏览器已暂停", unknown: "浏览器已暂停" })[reason ?? "unknown"];
}
export type BrowserTab = { id: string; title: string; url: string; recoveryUrl?: string; restore?: boolean };
export type BrowserView = BrowserSession & { network: BrowserNetwork; proxyAvailable: boolean; running: boolean; agentRunning: boolean; tabs: BrowserTab[];
  activeTab?: string; viewport: { width: number; height: number }; fileChooser: boolean;
  pendingSubmission?: { id: string; label: string };
  dialog?: { type: string; message: string }; files: { id: string; name: string; direction: "upload" | "download" }[] };
export type BrowserElement = { ref: string; role: string; name: string; value?: string; type?: string; options?: string[];
  disabled?: boolean; bounds?: { x: number; y: number; width: number; height: number } };
export const browserInputSchema = z.object({
  action: z.enum(["open", "set_network", "status", "observe", "screenshot", "navigate", "new_tab", "switch_tab", "close_tab", "click", "fill", "select", "press", "scroll", "upload", "wait", "dialog", "handoff"]),
  network: z.enum(["direct", "proxy"]).optional(), visual: z.boolean().optional(),
  url: z.string().max(4096).optional(), title: z.string().trim().min(1).max(40).optional(),
  tab: z.string().uuid().optional(), observation: z.string().uuid().optional(), ref: z.string().regex(/^e\d+$/).optional(),
  text: z.string().max(16000).optional(), key: z.string().max(80).optional(), value: z.string().max(2000).optional(),
  x: z.number().min(0).max(1280).optional(), y: z.number().min(0).max(900).optional(),
  delta: z.number().int().min(-2000).max(2000).optional(), seconds: z.number().min(0).max(10).optional(),
  file: z.string().uuid().optional(), accept: z.boolean().optional()
}).strict().refine(input => input.action !== "set_network" || input.network !== undefined, "请指定直连或代理")
  .refine(input => input.network === undefined || input.action === "open" || input.action === "set_network", "请使用 open 或 set_network 切换网络");
export type BrowserInput = z.infer<typeof browserInputSchema>;
export const browserControlSchema = z.object({
  id: z.string().uuid(), revision: z.number().int().positive(),
  action: z.enum(["takeover", "set_network", "viewport", "resume", "pause", "stop", "navigate", "restore_tab", "new_tab", "switch_tab", "close_tab", "click", "pointer", "focus_editor", "edit", "text", "key", "scroll", "dialog", "confirm_submission", "cancel_submission"]),
  network: z.enum(["direct", "proxy"]).optional(),
  viewportWidth: z.number().int().min(320).max(1280).optional(), viewportHeight: z.number().int().min(360).max(900).optional(),
  pendingId: z.string().uuid().optional(),
  editorId: z.string().uuid().optional(), editorVersion: z.number().int().positive().optional(),
  editStart: z.number().int().nonnegative().optional(), editEnd: z.number().int().nonnegative().optional(), expectedLength: z.number().int().nonnegative().optional(),
  pointerId: z.string().uuid().optional(), phase: z.enum(["down", "move", "up", "cancel"]).optional(),
  url: z.string().max(4096).optional(), tab: z.string().uuid().optional(), text: z.string().max(16000).optional(),
  key: z.string().max(80).optional(), x: z.number().min(0).max(1280).optional(), y: z.number().min(0).max(900).optional(),
  delta: z.number().int().min(-2000).max(2000).optional(), accept: z.boolean().optional()
}).strict().refine(input => input.action !== "set_network" || input.network !== undefined, "请指定直连或代理")
  .refine(input => input.network === undefined || input.action === "set_network", "请使用 set_network 切换网络");
export type BrowserControl = z.infer<typeof browserControlSchema>;
