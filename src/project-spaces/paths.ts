import { resolve } from "node:path";

export const hostRoot = resolve(process.env.ZIGENT_PROJECT_SPACES_ROOT ?? "data/project-spaces");
