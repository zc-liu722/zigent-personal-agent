import { randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { CodexWorker, workerConfigSchema } from "./codex/worker.js";
import { CodexRpc } from "./codex/rpc.js";
import { codexProjects } from "./codex/projects.js";

process.umask(0o077);
async function main() {
  const [action, file = join(homedir(), ".config", "zigent", "codex-worker.json"), endpoint, projectPath] = process.argv.slice(2);
  if (action === "init") {
    if (!endpoint) throw new Error("Usage: node dist/codex-worker.js init <config-path> <https-endpoint>");
    const config = workerConfigSchema.parse({ endpoint: endpoint.endsWith("/") ? endpoint : endpoint + "/", token: randomBytes(32).toString("base64url"), name: hostname(),
      statePath: join(dirname(resolve(file)), basename(file, ".json") + ".sqlite"), codexCommand: "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
      projectSource: "codex", projects: [] });
    await mkdir(dirname(resolve(file)), { recursive: true, mode: 0o700 }); await writeFile(file, JSON.stringify(config, null, 2), { mode: 0o600, flag: "wx" });
    console.info("Worker configuration created"); return;
  }
  if (!["pair", "run", "project-add", "projects"].includes(action ?? "")) throw new Error("Usage: node dist/codex-worker.js <init|pair|run|projects|project-add> [config-path]");
  const config = workerConfigSchema.parse(JSON.parse(await readFile(file, "utf8")));
  if (action === "project-add") {
    if (config.projectSource === "codex") throw new Error("请在 Codex 桌面端管理项目；项目清单会自动同步");
    const path = await realpath(process.argv[6] ?? "");
    if (!(await stat(path)).isDirectory()) throw new Error("项目目录不存在");
    const project = workerConfigSchema.shape.projects.removeDefault().element.parse({ id: endpoint, name: projectPath, path });
    const prior = config.projects.find(item => item.id === project.id);
    if (prior && prior.path !== path) throw new Error("项目标识已绑定其他目录，请使用新标识");
    config.projects = [...config.projects.filter(item => item.id !== project.id), project]; workerConfigSchema.parse(config);
    await writeFile(file, JSON.stringify(config, null, 2), { mode: 0o600 });
    console.info("项目已登记；重启执行器后同步到 Zigent。"); return;
  }
  if (config.codexArgs.join(" ") === "app-server proxy") {
    const daemon = spawnSync(config.codexCommand, ["app-server", "daemon", "start"], { stdio: "ignore", timeout: 30000 });
    if (daemon.status !== 0) throw new Error("Codex 后台接口未启动");
  }
  if (action === "projects") {
    if (config.projectSource === "manual") { console.info(JSON.stringify(config.projects)); return; }
    const rpc = new CodexRpc(config.codexCommand, config.codexArgs);
    try { await rpc.start(); console.info(JSON.stringify(await codexProjects(rpc))); } finally { rpc.close(); } return;
  }
  const worker = new CodexWorker(config);
  if (action === "pair") { try { const result = await worker.pair(); console.info(result.paired ? "设备已配对" : "请在 Zigent 使用配对码：" + result.code); } finally { await worker.close(); } return; }
  try {
  const paired = await worker.request<{ paired: boolean }>("pair-status"); if (!paired.paired) throw new Error("设备尚未配对，请先运行 pair");
  await worker.start(); console.info("Zigent local worker connected");
  await new Promise<void>(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  } finally { await worker.close(); }
}
main().catch(() => { console.error("本机执行器未完成启动或执行，请检查连接、配对和 Codex 后台接口。"); process.exitCode = 1; });
