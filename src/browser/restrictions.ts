import type { Page } from "playwright-core";
import { boundedBrowserWork } from "./operation.js";

export type BrowserRestriction = { origin: string; kind: "verification" | "rate_limit" | "access_denied"; detectedAt: number; retryAt?: number };

/** Automatic challenge intermediates also contain short-lived replay parameters,
 * but are not human verification pages while their normal scripts are running. */
export function browserTransientVerification(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) && parsed.hostname === "www.zhipin.com"
      && ["/web/passport/zp/security.html", "/web/passport/zp/security1.html"].includes(parsed.pathname);
  } catch { return false; }
}

/** Read only visible page headings/leading text. No network requests or form values.
 * A failed/incomplete inspection is unknown, never evidence that a challenge was solved.
 */
export async function inspectBrowserRestriction(page: Page): Promise<{ restriction?: BrowserRestriction; complete: boolean }> {
  const url = page.url(), routed = browserRestriction(url, "", "");
  return boundedBrowserWork(async () => {
    let seen = 0, complete = true;
    if (routed?.kind === "verification") return { restriction: routed, complete: true };
    for (const frame of page.frames()) {
      if (frame !== page.mainFrame()) {
        const element = await frame.frameElement();
        try { if (!await element.isVisible()) continue; } finally { await element.dispose(); }
      }
      if (++seen > 8) { complete = false; break; }
      const sample = await frame.evaluate(() => {
        const visible = (node: Element) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
        const headings = [...document.querySelectorAll('h1,h2,h3,[role="heading"]')].slice(0, 20).filter(visible).map(node => node.textContent?.trim().slice(0, 120) ?? "");
        let text = "", count = 0;
        const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
        while (text.length < 700 && count++ < 120 && walker.nextNode()) {
          const parent = walker.currentNode.parentElement;
          if (!parent || parent.closest("script,style,textarea,select,noscript") || !visible(parent)) continue;
          const value = walker.currentNode.textContent?.trim(); if (value) text += value.slice(0, 700 - text.length) + "\n";
        }
        return { title: document.title.slice(0, 200), headings, text, complete: document.readyState !== "loading" && Boolean(document.body) };
      });
      const title = sample.headings.find(heading => /^(?:安全验证|人机验证|security verification|verify (?:you are|you're) human)$/i.test(heading)) ?? sample.title;
      const restriction = browserRestriction(url, title, sample.text);
      if (restriction) return { restriction, complete: true };
      complete &&= sample.complete;
    }
    return { restriction: routed, complete };
  }, 1500).catch(error => {
    // A broken/loading 403 document is still restricted; DOM text only enriches
    // the known route with a recovery time when the page provides one.
    if (routed && page.url() === url) return { restriction: routed, complete: true };
    throw error;
  });
}

/** Classify known challenge routes, a challenge title or a short access-error heading, never arbitrary
 * occurrences in a job, article or quoted paragraph. The site decides the scope;
 * this does not infer that an account, IP or device has been banned globally. */
export function browserRestriction(url: string, title: string, text: string, now = Date.now()): BrowserRestriction | undefined {
  let origin: string, accessRoute = false;
  try {
    const parsed = new URL(url); if (!/^https?:$/.test(parsed.protocol)) return; origin = parsed.origin;
    // Public BOSS routes from its response interceptor and login bundles. Match
    // exact host/path, not words in a job URL, query or arbitrary page content.
    if (parsed.hostname === "www.zhipin.com") {
      if (["/web/passport/zp/verify.html",
        "/web/geek/safe-validate", "/web/geek/user-safe"].includes(parsed.pathname))
        return { origin, kind: "verification", detectedAt: now };
      accessRoute = parsed.pathname === "/web/passport/zp/403.html";
    }
  } catch { return; }
  const head = text.trim().slice(0, 700), heading = head.split("\n").find(line => line.trim())?.trim() ?? "";
  if (/安全验证|人机验证|security verification|verify (?:you are|you're) human/i.test(title)
    || /^(?:安全验证|人机验证|verify (?:you are|you're) human)$/i.test(heading))
    return { origin, kind: "verification", detectedAt: now };
  const restrictedHeading = /^(?:访问受限|请求过于频繁|Access Denied|Too Many Requests|Access Restricted)$/i.test(heading)
    || /^(?:访问受限|请求过于频繁|Access Denied|Too Many Requests|Access Restricted)$/i.test(title.trim());
  if (!accessRoute && (!restrictedHeading || !/请勿频繁|过于频繁|您的\s*IP|异常.{0,8}访问|暂时.{0,8}禁止|too many requests|temporarily (?:blocked|banned)|rate limit/i.test(head + " " + title))) return;
  const result: BrowserRestriction = { origin, kind: !accessRoute && /频繁|too many requests|rate limit/i.test(head) ? "rate_limit" : "access_denied", detectedAt: now };
  const until = /(?:将于|恢复时间[:：]?)\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?::(\d{2}))?/.exec(head);
  if (until) {
    const retryAt = Date.parse(`${until[1]}T${until[2]}:${until[3] ?? "00"}+08:00`);
    if (Number.isFinite(retryAt)) result.retryAt = retryAt;
  }
  return result;
}
