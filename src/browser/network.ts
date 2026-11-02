import { lookup } from "node:dns/promises";
import { isIP, BlockList } from "node:net";

const denied = new BlockList();
for (const [ip, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) denied.addSubnet(ip, bits, "ipv4");
for (const [ip, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const)
  denied.addSubnet(ip, bits, "ipv6");

export function publicAddress(ip: string): boolean {
  const normalized = ip.replace(/^\[|\]$/g, "");
  const family = isIP(normalized);
  return Boolean(family && !denied.check(normalized, family === 4 ? "ipv4" : "ipv6"));
}

/** Application-level filtering supplements the Chromium sandbox and host firewall. */
export async function browserUrl(raw: string, testLocal = false): Promise<string> {
  const url = new URL(raw);
  if (!["https:", "http:", "wss:", "ws:"].includes(url.protocol) || url.username || url.password)
    throw new Error("仅支持公开网站的 HTTP 或 HTTPS 地址");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (testLocal && ["127.0.0.1", "localhost", "::1"].includes(host)) return url.href;
  if (!host.includes(".") && !isIP(host) || /(?:^|\.)(?:localhost|local|internal|home|lan)$/.test(host))
    throw new Error("不能访问服务器内网地址");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error("不能访问服务器内网地址");
  return url.href;
}
