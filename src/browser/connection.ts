import type { BrowserNetwork } from "./types.js";

/** The caller chooses a route, never an arbitrary proxy endpoint. No system proxy fallback. */
export function browserConnection(network: BrowserNetwork, proxyUrl?: string) {
  if (network === "direct") return { args: ["--no-proxy-server"] };
  if (!proxyUrl) throw new Error("浏览器代理未配置，请使用直连");
  try {
    const url = new URL(proxyUrl);
    if (url.hostname === "localhost") url.hostname = "127.0.0.1";
    if (!["http:", "https:", "socks5:"].includes(url.protocol) || url.pathname !== "/" && url.pathname !== "" || url.search || url.hash)
      throw new Error();
    const username = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
    if (url.protocol === "socks5:" && (username || password)) throw new Error();
    return { args: [], proxy: { server: url.origin === "null" ? `${url.protocol}//${url.host}` : url.origin,
      ...(username ? { username } : {}), ...(password ? { password } : {}) } };
  } catch { throw new Error("浏览器代理配置不可用，请使用直连"); }
}
