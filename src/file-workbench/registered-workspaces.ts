export type RegisteredWorkspaceSource = { id: string; name: string; workspaceId?: string; windows?: string };
export type RegisteredWorkspaceRecord = { project: string; workspaceId: string; name: string; cwd: string; liveProject: true };

function failureText(error: unknown): string {
  return (error instanceof Error ? error.message : "unavailable").replace(/[\r\n]+/g, " ").slice(0, 200);
}

/** Adopt each registered directory independently. One failure must not hide the others. */
export async function loadRegisteredWorkspaces(
  agentId: string,
  list: () => Promise<readonly RegisteredWorkspaceSource[]>,
  register: (workspaceId: string, name: string, directory: string) => Promise<unknown>,
  log: (message: string) => void = console.warn
): Promise<RegisteredWorkspaceRecord[]> {
  let spaces: readonly RegisteredWorkspaceSource[];
  try { spaces = await list(); }
  catch (error) {
    log(`PROJECT_WORKSPACE_REFRESH_FAILED agent=${agentId} ${failureText(error)}`);
    return [];
  }
  const projects: RegisteredWorkspaceRecord[] = [];
  for (const space of spaces) {
    if (!space.workspaceId) continue;
    if (!space.windows) {
      log(`PROJECT_WORKSPACE_REGISTER_FAILED agent=${agentId} project=${space.id} directory unavailable`);
      continue;
    }
    try {
      await register(space.workspaceId, space.name, space.windows);
      projects.push({ project: space.id, workspaceId: space.workspaceId, name: space.name, cwd: space.windows, liveProject: true });
    } catch (error) {
      log(`PROJECT_WORKSPACE_REGISTER_FAILED agent=${agentId} project=${space.id} ${failureText(error)}`);
    }
  }
  return projects;
}
