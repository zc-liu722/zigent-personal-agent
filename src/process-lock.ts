import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

type ReleaseLock = () => Promise<void>;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function acquireAgentLock(
  agentId: string,
  runtimeDirectory = ".runtime"
): Promise<ReleaseLock> {
  const directory = resolve(runtimeDirectory);
  const path = join(directory, `${agentId}.pid`);
  const owner = `${process.pid}\n`;
  await mkdir(directory, { recursive: true });

  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(owner, "utf8");
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(path, { force: true });
        throw error;
      }
      await handle.close();

      let released = false;
      return async () => {
        if (released) return;
        released = true;
        const currentOwner = await readFile(path, "utf8").catch(() => "");
        if (currentOwner === owner) await rm(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const rawPid = await readFile(path, "utf8").catch(() => "");
      const pid = Number.parseInt(rawPid.trim(), 10);
      if (Number.isInteger(pid) && isProcessAlive(pid)) {
        throw new Error(`Agent ${agentId} is already running (pid ${pid})`);
      }
      await rm(path, { force: true });
    }
  }
}
