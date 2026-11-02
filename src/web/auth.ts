import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { data, json, type WebRoute } from "./http.js";
import { DEVICE_LIFETIME, verifyPassword, type WebStore } from "./store.js";

/** Browser device authentication only; OAuth callbacks and event bearer tokens keep their own boundary. */
export function createWebAuthentication(store: WebStore, agentId: string, BASE: string) {
  const COOKIE = `__Secure-${agentId}-device`;
  function cookie(res: ServerResponse, token: string, expire = false): void {
    res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=${BASE}; HttpOnly; Secure; SameSite=Strict; Max-Age=${expire ? 0 : DEVICE_LIFETIME / 1000}`);
  }
  function token(req: IncomingMessage): string {
    return req.headers.cookie?.split(";").map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? "";
  }

  const login: WebRoute = async ({ route, req, res }) => {
    if (route === "api/login" && req.method === "POST") {
      const clientIp = String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "unknown");
      if (!store.allowLogin(clientIp)) { json(res, 429, { error: "尝试次数过多，请 15 分钟后再试。" }); return true; }
      const input = z.object({ password: z.string().min(1).max(256) }).parse(await data(req));
      if (!await verifyPassword(input.password, store.setting("password")!)) { json(res, 401, { error: "密码不正确。" }); return true; }
      cookie(res, store.createDevice()); json(res, 200, { ok: true }); return true;
    }
    return false;
  };
  const account: WebRoute = async ({ route, req, res, credential }) => {
    if (route === "api/logout" && req.method === "POST") { store.revoke(credential); cookie(res, "", true); json(res, 200, { ok: true }); return true; }
    if (route === "api/password" && req.method === "POST") {
      const input = z.object({ current: z.string().max(256), password: z.string().min(12).max(256) }).parse(await data(req));
      if (!store.allowLogin(`password:${credential}`)) { json(res, 429, { error: "尝试次数过多，请稍后再试。" }); return true; }
      if (!await verifyPassword(input.current, store.setting("password")!)) { json(res, 403, { error: "当前密码不正确。" }); return true; }
      await store.changePassword(input.password); cookie(res, store.createDevice()); json(res, 200, { ok: true }); return true;
    }
    return false;
  };
  function authenticate(req: IncomingMessage, res: ServerResponse): string | undefined {
    const credential = token(req);
    if (!store.authenticate(credential)) { cookie(res, "", true); json(res, 401, { error: "请先登录。" }); return; }
    cookie(res, credential);
    return credential;
  }
  return { token, authenticate, login, account };
}
