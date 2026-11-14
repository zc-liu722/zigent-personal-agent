import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ModelDeployment } from "../../config.js";
import { AcpError, acpProcessEnvironment } from "../../models/acp/client.js";

export function cursorProcess(route: ModelDeployment, workspace: string, cursorDir: string, proxy?: string): ChildProcessWithoutNullStreams {
  const command = route.command!;
  const batch = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
  // The installed Windows launcher is a batch file. Only a checked absolute path
  // and the fixed model IDs admitted by the adapter may reach cmd.exe.
  if (batch && !/^[a-z]:[\\/][a-z0-9 ._\\/-]+\.cmd$/i.test(command)) {
    throw new AcpError("configuration", "Cursor CLI 安装路径无效。");
  }
  const env = acpProcessEnvironment(proxy);
  Object.assign(env, {
    CURSOR_API_KEY: route.apiKey!,
    CURSOR_CONFIG_DIR: cursorDir,
    HOME: workspace, USERPROFILE: workspace, LOCALAPPDATA: workspace, APPDATA: workspace,
    TEMP: workspace, TMP: workspace, NO_OPEN_BROWSER: "1"
  });
  const args = ["--model", route.apiModel, "--sandbox", "enabled", "acp"];
  if (batch) {
    return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `""${command.replaceAll("/", "\\")}" ${args.join(" ")}"`],
      { cwd: workspace, env, windowsVerbatimArguments: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  }
  return spawn(command, args, { cwd: workspace, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
}
