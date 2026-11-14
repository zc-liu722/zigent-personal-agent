import { agentId, inventory, spaces, version } from "./project-spaces/policy.js";

const [action, agent, registry = "ops/project-spaces/projects.json"] = process.argv.slice(2);
agentId.parse(agent);
if (action !== "inventory") throw new Error("Use inventory with an exact agent; Linux project synchronization is retired");
for (const space of await spaces(agent!, registry)) {
  const files = await inventory(space, space.windows!);
  console.info(JSON.stringify({ project: space.id, count: files.length, version: version(files) }));
}
