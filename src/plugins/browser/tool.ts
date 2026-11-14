import { BROWSER_READ_TIMEOUT, BROWSER_OPERATION_TIMEOUT } from "../../browser/operation.js";
import type { BrowserService } from "../../browser/service.js";
import type { AgentToolRegistration } from "../../tools/tool-contracts.js";
import type { ToolActivityPresentation } from "../../tools/activity-presentation.js";
import { browserStateMessage, type BrowserMode, type BrowserPauseReason } from "../../browser/types.js";

const actions = ["open", "set_network", "status", "observe", "screenshot", "capture_image", "navigate", "new_tab", "switch_tab", "close_tab", "click", "fill", "select", "press", "scroll", "upload", "wait", "dialog", "handoff"];
const labels: Record<string, string> = { set_network: "切换浏览器网络", open: "打开浏览器", observe: "阅读网页", screenshot: "查看页面", navigate: "打开网页", new_tab: "打开标签页", switch_tab: "切换标签页", close_tab: "关闭标签页", click: "操作页面", fill: "填写表单", select: "选择选项", press: "操作页面", scroll: "浏览页面", upload: "上传所选文件", wait: "等待页面", dialog: "处理页面弹窗", handoff: "暂停浏览器", status: "查看浏览器状态" };
function action(input: unknown) { return input && typeof input === "object" ? String((input as { action?: unknown }).action) : ""; }
function browserHeading(input: unknown): { title: string; actionKind?: ToolActivityPresentation["actionKind"] } {
  const step = action(input);
  return { title: Object.hasOwn(labels, step) ? labels[step]! : "查看浏览器操作",
    actionKind: step === "wait" ? "wait" : step === "screenshot" || step === "capture_image" ? "image" : undefined };
}
export function createBrowserTool(service?: BrowserService): AgentToolRegistration {
  return {
    available: Boolean(service), executionMode: "sequential",
    definition: { type: "function", name: "browser", description: [
      "Private browser with user viewing/takeover. Use only for necessary site interaction (login/forms/uploads), otherwise unavailable visual/dynamic content, or explicit browser requests. Prefer dedicated tools/APIs; public research uses web_search/non-browser retrieval, even when search is poor.",
      "open connects; status lists mode/tabs/upload IDs; observe returns untrusted text and live refs. Default network=direct (preferred for mainland sites); proxy requires status.proxyAvailable. Switching restarts tabs, retaining cookies/recoverable URLs but losing forms/refs: re-observe; never replay submissions or switch to evade challenges.",
      "Actions need latest observation and observed refs; never guess refs/coordinates/URLs or use JS/shell/local paths/CDP. visual=true gives DOM+screenshot: use for unfamiliar/custom/canvas/map controls, failed refs, coordinate actions and visual verification; text-heavy steps may use DOM-only. Coordinates need a current screenshot; nested-frame refs lack viewport bounds.",
      "fill(ref,text), select(ref,value), press(key), scroll(delta), upload(ref,user-uploaded file ID), switch_tab/close_tab(tab), navigate/new_tab(url), dialog(accept,text?), wait(seconds<=10). Verify after short sequences and before claiming success.",
      "observe exposes img/canvas/svg/figure refs, img imageUrl/natural dimensions. image_assets: webpage discovers public images; present(url) delivers originals; present(observation,ref) delivers element snapshots when originals are unavailable (dynamic/authenticated/canvas). capture_image is model-only inspection.",
      "In necessary workflows, execute requested searches/filters/ordinary forms/saves/login-code requests; never repeatedly send codes, invent answers or repeat uncertain submissions. Handoff manual CAPTCHA/security/QR/password/private-code steps; never bypass or request passwords in chat. Payments/messages/posts/applications need authenticated confirmation.",
      "Restricted sites: no ban-scope inference, retry/refresh/reroute/reopen before recovery. navigation_loop needs explicit user recovery; new messages/control return never clear visible challenges. Otherwise a new user message allows open/observe. Mid-turn user/paused/stopped requires waiting; viewer closure is not control return; never infer user activity from pause state.",
      "After 10 idle minutes, process closes retaining cookies/URLs; status/viewer polling cannot keep it alive. idle+resumeOnUse allows open/observe relaunch; otherwise honor takeover/security handoff. Re-observe after restart; refs/forms/confirmations may be stale. Recurring work: proactive_tasks, title<=4 characters."
    ].join(" "), input_schema: { type: "object", additionalProperties: false, required: ["action"], properties: {
      action: { type: "string", enum: actions }, url: { type: "string", maxLength: 4096 }, title: { type: "string", maxLength: 40 },
      network: { type: "string", enum: ["direct", "proxy"] }, visual: { type: "boolean" },
      tab: { type: "string" }, observation: { type: "string" }, ref: { type: "string" }, text: { type: "string", maxLength: 16000 },
      key: { type: "string" }, value: { type: "string" }, x: { type: "number" }, y: { type: "number" }, delta: { type: "integer" },
      seconds: { type: "number", maximum: 10 }, file: { type: "string" }, accept: { type: "boolean" }
    } } },
    activity: {
      started: input => {
        const heading = browserHeading(input);
        return { ...heading, message: `我正在${heading.title}。` };
      },
      completed: (input, result) => {
        const heading = browserHeading(input);
        const state = result && typeof result === "object" ? result as { status?: string; mode?: string; pauseReason?: BrowserPauseReason } : undefined;
        const status = state?.status ?? state?.mode;
        if (status === "observation_pending") return { ...heading, message: "操作已执行，我需要继续核对页面结果。" };
        if (status === "pending_confirmation") return { ...heading, message: "提交需你在操作区确认，尚未执行。" };
        if (action(input) === "set_network" && state && "network" in state && (state.network === "direct" || state.network === "proxy"))
          return { ...heading, message: `我已将浏览器切换为${state.network === "direct" ? "直连" : "代理"}。` };
        return { ...heading, message: status && ["user", "paused", "stopped"].includes(status) ? browserStateMessage(status as BrowserMode, state?.pauseReason) + "。" : `我已${heading.title}。` };
      },
      failed: (input, error) => ({ ...browserHeading(input), message: error === BROWSER_READ_TIMEOUT ? "我读取网页超时了，请继续浏览后重试。"
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
