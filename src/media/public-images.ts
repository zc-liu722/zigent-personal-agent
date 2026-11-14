import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch } from "undici";
import { parseHTML } from "linkedom";
import { browserUrl, publicAddress } from "../browser/network.js";

export type ImageCandidate = { url: string; sourceUrl: string; title?: string; width?: number; height?: number };
const addressAllowed = (address: string) => publicAddress(address) && (isIP(address) !== 6 || /^[23]/i.test(address) && !/^(?:2001:(?:0*:|db8:)|2002:)/i.test(address));
// Validate AND pin DNS at connection time. Revalidate each redirect; never forward credentials.
const dispatcher = new Agent({ connect: { lookup(host, _options, callback) {
  void lookup(host, { all: true, verbatim: true }).then(addresses => {
    if (!addresses.length || addresses.some(item => !addressAllowed(item.address))) throw new Error("不能读取内网图片。");
    if (_options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  }).catch(error => callback(error, "", 4));
} } });

export async function readPublicMedia(raw: string, kind: "image" | "page", signal?: AbortSignal, sourceUrl?: string) {
  const requestSignal = AbortSignal.any([AbortSignal.timeout(25_000), ...(signal ? [signal] : [])]);
  let url = raw;
  for (let redirects = 0; redirects <= 5; redirects++) {
    url = await browserUrl(url);
    const target = new URL(url);
    if (!["https:", "http:"].includes(target.protocol) || isIP(target.hostname.replace(/^\[|\]$/g, "")) && !addressAllowed(target.hostname.replace(/^\[|\]$/g, ""))) throw new Error("图片网址无效。");
    const response = await fetch(url, { dispatcher, redirect: "manual", signal: requestSignal,
      headers: { "User-Agent": "zigent/0.1.0", Accept: kind === "page" ? "text/html,application/xhtml+xml" : "image/*",
        ...(sourceUrl ? { Referer: new URL(await browserUrl(sourceUrl)).origin + "/" } : {}) } });
    if ([301,302,303,307,308].includes(response.status)) {
      await response.body?.cancel();
      const next = response.headers.get("location"); if (!next) throw new Error("图片重定向缺少目标。");
      url = new URL(next, url).href; continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`网页资源读取失败（HTTP ${response.status}）。`); }
    const mime = (response.headers.get("content-type") ?? "").split(";")[0].toLowerCase();
    if (kind === "page" ? !["text/html","application/xhtml+xml"].includes(mime) : !mime.startsWith("image/")) {
      await response.body?.cancel(); throw new Error(kind === "image" ? "该地址未返回图片；可从来源网页获取或截取图像。" : "该地址未返回 HTML 网页。");
    }
    const maximum = kind === "page" ? 3 * 1024 ** 2 : 20 * 1024 ** 2;
    const chunks: Buffer[] = []; let size = 0;
    if (Number(response.headers.get("content-length")) > maximum) { await response.body?.cancel(); throw new Error("网页资源过大。"); }
    if (response.body) for await (const chunk of response.body) {
      size += chunk.length; if (size > maximum) { await response.body.cancel().catch(() => {}); throw new Error("网页资源过大。"); }
      chunks.push(Buffer.from(chunk));
    }
    return { url, mime, bytes: Buffer.concat(chunks) };
  }
  throw new Error("网页资源重定向次数过多。");
}

export async function discoverPageImages(url: string, signal?: AbortSignal): Promise<{ sourceUrl: string; title: string; images: ImageCandidate[] }> {
  const page = await readPublicMedia(url, "page", signal);
  const { document } = parseHTML(page.bytes.toString("utf8"));
  const images = new Map<string, ImageCandidate>();
  const base = document.querySelector("base[href]")?.getAttribute("href");
  let baseUrl = page.url; try { if (base) baseUrl = new URL(base, page.url).href; } catch { /* Keep document URL. */ }
  const add = (value: string | null, title?: string, width?: number, height?: number) => {
    if (!value) return;
    try {
      const url = new URL(value, baseUrl);
      if (!["https:","http:"].includes(url.protocol) || url.username || url.password || images.has(url.href) || images.size >= 60) return;
      images.set(url.href, { url: url.href, sourceUrl: page.url, title: title?.slice(0,200), width, height });
    } catch { /* Ignore malformed third-party attributes. */ }
  };
  for (const element of document.querySelectorAll("img,source,meta[property='og:image'],meta[name='twitter:image']")) {
    const title = element.getAttribute("alt") ?? element.getAttribute("title") ?? undefined;
    const width = Number(element.getAttribute("width")) || undefined, height = Number(element.getAttribute("height")) || undefined;
    const srcset = element.getAttribute("srcset") ?? element.getAttribute("data-srcset");
    if (srcset) for (const src of srcset.split(",").reverse()) add(src.trim().split(/\s+/)[0], title, width, height);
    add(element.getAttribute("data-src") ?? element.getAttribute("data-original") ?? element.getAttribute("src") ?? element.getAttribute("content"), title, width, height);
  }
  return { sourceUrl: page.url, title: document.title.slice(0,200), images: [...images.values()] };
}
