import type { ElementHandle, Page } from "playwright-core";

export type BrowserActionPolicy = { label: string; confirm: boolean; verification: boolean; submits: boolean };

/** Runs in the target's own document, including nested frames. No credential/message values. */
function describeAction(node: Node | null, enter: boolean): BrowserActionPolicy {
  const doc = node?.ownerDocument ?? document;
  let element = node as HTMLElement | null;
  const control = element?.closest('button,input,a,[role="button"],[role="link"],[onclick],[tabindex]') as HTMLInputElement | null;
  let form = (element as HTMLInputElement | null)?.form ?? element?.closest("form");
  const editable = element?.closest('textarea,[contenteditable="true"],[role="textbox"]');
  const implicit = enter && form ? Array.from(form.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input[type="submit"],input[type="image"]'))
    .find(button => button.type === "submit" || button.type === "image") : undefined;
  if (enter && implicit && !control?.matches('button,[role="button"],a[href],input[type="submit"],input[type="image"]')) element = implicit;
  else if (control) element = control;
  form = (element as HTMLInputElement | null)?.form ?? form;
  const field = element as HTMLInputElement | null;
  const fieldLabel = /^(INPUT|TEXTAREA|SELECT)$/.test(element?.tagName ?? "") ? field?.labels?.[0]?.textContent : undefined;
  const buttonValue = element?.tagName === "INPUT" && /^(submit|image|button)$/.test(field?.type ?? "") ? field?.value : undefined;
  const textField = /^(INPUT|TEXTAREA|SELECT)$/.test(element?.tagName ?? "") || element?.isContentEditable || element?.getAttribute("role") === "textbox";
  const label = (element?.getAttribute("aria-label") || element?.getAttribute("title") || fieldLabel || buttonValue
    || (!textField ? element?.textContent : "") || "").trim().slice(0, 180);
  const headings = Array.from(doc.querySelectorAll('h1,h2,[role="heading"]')).filter(item => (item as HTMLElement).getBoundingClientRect().height > 0).map(item => item.textContent).join(" ");
  const challenge = /安全验证|人机验证|滑块验证|拼图验证|请完成.{0,8}验证|security verification|verify (?:you are|you're) human|are you (?:a )?(?:human|robot)/i;
  const challengeFrame = /(?:recaptcha|hcaptcha|challenges\.cloudflare\.com)/i.test(doc.location.href);
  const verification = challengeFrame || challenge.test(doc.title + " " + headings + " " + label)
    || Boolean(element?.closest('[class*="g-recaptcha"],[class*="h-captcha"],[class*="geetest"],[class*="yidun"],[class*="nc-container"],[class*="verify-bar"]'));
  const submits = Boolean(enter && form || (element as HTMLInputElement | null)?.type === "submit" || (element as HTMLInputElement | null)?.type === "image");
  // Inspect semantics and form purpose, not the mere existence of an HTML submit button.
  const container = element?.parentElement;
  const composer = container && container !== doc.body && container.querySelector('textarea,[contenteditable="true"],[role="textbox"]') ? container : undefined;
  const context = form ?? element?.closest('[role="dialog"],[role="form"]') ?? editable?.parentElement ?? composer;
  const purpose = [context?.getAttribute("aria-label"), context?.id, form?.getAttribute("action"), context?.textContent?.slice(0, 2000),
    ...Array.from(context?.querySelectorAll('input,textarea,[contenteditable="true"]') ?? []).map(field => [field.getAttribute("name"), field.getAttribute("aria-label"), field.getAttribute("placeholder")].join(" "))].join(" ");
  const payment = /支付|付款|购买|下单|结算|充值|订购|续费|打赏|转账|捐款|\b(?:pay|payment|purchase|buy|checkout|place order|transfer|donate)\b/i;
  const message = /投递|申请职位|立即申请|发送|发消息|发信息|发私信|发邮件|沟通|打招呼|回复|发布|发表评论|联系(?:招聘|雇主|对方|客服)|\b(?:apply|send|reply|publish|post message|post comment|chat|message|submit application)\b/i;
  const code = /^(?:(?:重新|再次)?(?:发送|获取|接收)(?:短信|手机|邮箱|邮件|登录)?验证码|(?:send|get|request|resend)\s+(?:(?:sms|email|login|verification|one.time)\s+)*(?:code|otp))\s*[！!。.]?$/i;
  const routine = /搜索|查询|筛选|查找|登录|登陆|注册|保存|删除|\b(?:search|find|filter|log ?in|sign ?in|sign ?up|save|delete)\b/i;
  const confirm = payment.test(label) || (!code.test(label) && (message.test(label)
    || ((submits || enter || /^(?:确认|确定|提交|完成|ok|confirm|submit|done)$/i.test(label)) && !routine.test(label) && (payment.test(purpose) || message.test(purpose)))));
  return { label: label.slice(0, 80) || "提交表单", confirm, verification, submits };
}

export async function browserActionPolicy(page: Page, target: ElementHandle | undefined, input: { enter?: boolean; x?: number; y?: number }): Promise<BrowserActionPolicy> {
  if (target) return target.evaluate(describeAction, Boolean(input.enter));
  if (input.x !== undefined && input.y !== undefined) {
    // elementFromPoint stops at an iframe. Descend using observed frame geometry.
    let frame = page.mainFrame(), x = input.x, y = input.y;
    for (let depth = 0; depth < 12; depth++) {
      const handle = await frame.evaluateHandle(({ x, y }) => document.elementFromPoint(x, y), { x, y });
      const element = handle.asElement();
      const child = await element?.contentFrame();
      if (!child || !element) { try { return await handle.evaluate(describeAction, Boolean(input.enter)); } finally { await handle.dispose(); } }
      const offset = await element.evaluate(node => { const rect = node.getBoundingClientRect(); return { x: rect.left + node.clientLeft, y: rect.top + node.clientTop }; });
      await handle.dispose(); frame = child; x -= offset.x; y -= offset.y;
    }
    throw new Error("页面嵌套过深，请使用元素引用");
  }
  // Keyboard commands without refs act on the focused frame, not necessarily the main document.
  for (const frame of page.frames()) {
    if (frame !== page.mainFrame()) {
      const host = await frame.frameElement();
      try { if (!await host.isVisible()) continue; }
      finally { void host.dispose().catch(() => {}); }
    }
    if (!await frame.evaluate(() => document.hasFocus() && document.activeElement?.tagName !== "IFRAME").catch(() => false)) continue;
    const handle = await frame.evaluateHandle(() => document.activeElement);
    try { return await handle.evaluate(describeAction, Boolean(input.enter)); } finally { await handle.dispose(); }
  }
  return { label: "", confirm: false, verification: false, submits: false };
}
