import { readFile } from "node:fs/promises";
import { BeijingSubway, readSnapshot } from "./transit/beijing-subway.js";
import { createAgentToolSet } from "./tools/registry.js";

const [directory, manifestPath] = process.argv.slice(2);
if (!directory || !manifestPath || process.argv.length !== 4) throw new Error("Usage: beijing-subway-verify <cache-directory> <manifest>");
const snapshot = await readSnapshot(directory);
if (!snapshot || snapshot.failures.length) throw new Error("Subway snapshot incomplete");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const table = snapshot.records.flatMap(r => r.tables)[0];
if (!table) throw new Error("No local timetable images");
for (const profile of manifest.agents.filter((a: { enabled: boolean }) => a.enabled)) {
  if (!profile.allowedTools.includes("beijing_subway")) throw new Error("Subway tool is not enabled");
  const tools = createAgentToolSet(profile.id, ["beijing_subway"], {}, { beijingSubway: new BeijingSubway(directory) });
  const context = { agentId: profile.id, userId: "subway-release-verification", sessionId: "subway-release-verification", turnId: 0 };
  const status = await tools.execute("beijing_subway", { action: "status" }, context) as { status: string; tables: number; stations: number };
  const viewed = await tools.execute("beijing_subway", { action: "view", table_ids: [table.id] }, context) as { images?: unknown[] };
  if (status.status !== "available" || viewed.images?.length !== 1) throw new Error("Subway query verification failed");
  console.info(`SUBWAY_QUERY agent=${profile.id} status=ok stations=${status.stations} tables=${status.tables} local_image=ok`);
}
