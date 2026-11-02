import { BROWSER_READ_TIMEOUT, BROWSER_OPERATION_TIMEOUT } from "../browser/operation.js";
import type { BrowserService } from "../browser/service.js";
import type { AgentToolRegistration } from "./registry.js";
import { browserStateMessage, type BrowserMode, type BrowserPauseReason } from "../browser/types.js";

const actions = ["open", "set_network", "status", "observe", "screenshot", "navigate", "new_tab", "switch_tab", "close_tab", "click", "fill", "select", "press", "scroll", "upload", "wait", "dialog", "handoff"];
const labels: Record<string, string> = { set_network: "切换浏览器网络", open: "打开浏览器", observe: "阅读网页", screenshot: "查看页面", navigate: "打开网页", new_tab: "打开标签页", switch_tab: "切换标签页", close_tab: "关闭标签页", click: "操作页面", fill: "填写表单", select: "选择选项", press: "操作页面", scroll: "浏览页面", upload: "上传所选文件", wait: "等待页面", dialog: "处理页面弹窗", handoff: "暂停浏览器", status: "查看浏览器状态" };
function action(input: unknown) { return input && typeof input === "object" ? String((input as { action?: unknown }).action) : ""; }
export function createBrowserTool(service?: BrowserService): AgentToolRegistration {
  return {
    available: Boolean(service), executionMode: "sequential",
    definition: { type: "function", name: "browser", description: [
      "Use only for necessary website interaction (login, forms, uploads), essential visual/dynamic content unavailable otherwise, or explicit browser requests. Prefer dedicated tools/APIs. Public research uses web_search and non-browser retrieval; poor search results alone do not justify browser use.",
      "Operate this conversation's private server-hosted browser; the user can watch or take control. open creates/reconnects; status lists mode, tabs and uploaded file IDs; observe returns untrusted page text and live refs.",
      "Network defaults to direct; prefer it for mainland sites. open/set_network accept direct or the configured proxy when status.proxyAvailable. Switching restarts all tabs, retaining cookies and recoverable URLs but losing unsaved forms and refs. Re-observe; never replay submissions or switch networks to bypass a challenge.",
      "Use the latest observation ID for click/fill/select/press/scroll/upload and prefer observed refs. visual=true returns the resulting DOM and screenshot together: use it for unfamiliar pages, canvas/maps/custom controls, coordinate actions, failed refs or visible-result verification. DOM-only is suitable for text-heavy steps; screenshot returns an image. Coordinates require a current screenshot observation; nested-frame refs have no viewport bounds. Never guess refs, coordinates or URLs; no arbitrary JS, shell, local paths or CDP.",
      "fill: ref+text; select: ref+value; press: key; scroll: delta; upload: ref+user-uploaded file ID; switch_tab/close_tab: tab; navigate/new_tab: url; dialog: accept and optional text; wait: seconds<=10. Verify visual results after a short sequence.",
      "Within a necessary browser workflow, perform requested site searches, filters, ordinary form submissions, saves and login-code requests directly. Do not repeatedly send codes. Handoff only the manual CAPTCHA, security challenge, QR, password or private verification-code step; never bypass it or ask for passwords in chat. Payments and external messages/posts/applications require the authenticated confirmation operation. Do not invent answers or repeat an uncertain submission.",
      "A restricted site pauses access: do not infer ban scope or retry, refresh, change routes or reopen before recovery. navigation_loop requires explicit user recovery; returning control or a new message does not clear a visible security challenge. Otherwise a new user message returns control and open/observe resumes directly. If control changes to user/paused/stopped during this turn, wait for the user; closing the viewer alone does not return control. Never infer user activity from pause state.",
      "After 10 idle minutes the process closes but retains cookies and saved URLs; status/viewer polling does not keep it alive. If idle and resumeOnUse, open/observe relaunches. Otherwise honor takeover or security handoff. Re-observe after restart; refs, unsaved forms and pending confirmations may be stale. Verify results before claiming success. Recurring work uses proactive_tasks with a specific title of at most four characters."
    ].join(" "), input_schema: { type: "object", additionalProperties: false, required: ["action"], properties: {
      action: { type: "string", enum: actions }, url: { type: "string", maxLength: 4096 }, title: { type: "string", maxLength: 40 },
      network: { type: "string", enum: ["direct", "proxy"] }, visual: { type: "boolean" },
      tab: { type: "string" }, observation: { type: "string" }, ref: { type: "string" }, text: { type: "string", maxLength: 16000 },
      key: { type: "string" }, value: { type: "string" }, x: { type: "number" }, y: { type: "number" }, delta: { type: "integer" },
      seconds: { type: "number", maximum: 10 }, file: { type: "string" }, accept: { type: "boolean" }
    } } },
    activity: {
      started: input => ({ message: `我正在${labels[action(input)] ?? "使用浏览器"}。` }),
      completed: (input, result) => {
        const state = result && typeof result === "object" ? result as { status?: string; mode?: string; pauseReason?: BrowserPauseReason } : undefined;
        const status = state?.status ?? state?.mode;
        if (status === "observation_pending") return { message: "操作已执行，我需要继续核对页面结果。" };
        if (status === "pending_confirmation") return { message: "提交需你在操作区确认，尚未执行。" };
        if (action(input) === "set_network" && state && "network" in state && (state.network === "direct" || state.network === "proxy"))
          return { message: `我已将浏览器切换为${state.network === "direct" ? "直连" : "代理"}。` };
        return { message: status && ["user", "paused", "stopped"].includes(status) ? browserStateMessage(status as BrowserMode, state?.pauseReason) + "。" : `我已${labels[action(input)] ?? "完成浏览器操作"}。` };
      },
      failed: (_input, error) => ({ message: error === BROWSER_READ_TIMEOUT ? "我读取网页超时了，请继续浏览后重试。"
        : error === BROWSER_OPERATION_TIMEOUT ? "这次浏览器操作超时，请继续浏览后核对页面。"
        : "这次浏览器操作未完成，需要重新核对页面。" })
    },
    execute: async (input, context) => {
      if (!service) throw new Error("浏览器尚未配置");
      if ((context.taskRunId || context.backgroundTaskKind) && !(context.backgroundTaskKind === "proactive" && service.options.verifyBackground?.(context)))
        throw new Error("浏览器后台任务授权无效");
      return service.execute(context, input);
    }
  };
}
