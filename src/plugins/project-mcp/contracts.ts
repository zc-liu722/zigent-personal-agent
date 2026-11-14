import { z } from "zod";

export const projectMcpPath = "/mcp/projects";
export const projectMcpLocalPath = "/_project-mcp";
export const projectMcpTokenHeader = "x-zigent-project-token";
export const maxRequestBytes = 6 * 1024 * 1024;
export const maxReadBytes = 32 * 1024 * 1024;
export const maxWriteBytes = 4 * 1024 * 1024;

const offset = z.number().int().nonnegative().max(100_000_000).default(0);
const page = { offset, limit: z.number().int().min(1).max(100).default(50) };
const agent = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const path = z.string().min(1).max(1024).describe("Path relative to the project root, with / separators.");
const directory = path.default(".");
const target = { workspaceId: z.string().uuid() };
const file = { ...target, path };
const sha256 = z.string().regex(/^[a-f0-9]{64}$/).describe("The sha256 returned by read_file for the version being changed.");
export const maxTextReadLimit = 24_000;
export const maxBinaryReadLimit = 1024 * 1024;
const readLimit = z.number().int().min(1).max(maxBinaryReadLimit).default(12_000);

export const projectMcpTools = {
  list_projects: {
    description: "List Zigent's persistent project workspaces. Call with no arguments to see each Agent's first page; set agent and offset to continue that Agent's list.",
    readOnly: true,
    input: z.object({ agent: agent.optional(), ...page })
  },
  list_files: {
    description: "List a project directory. Use nextOffset to continue. Paths and workspace IDs are relative to the Agent returned by list_projects.",
    readOnly: true,
    input: z.object({ agent, ...target, path: directory, ...page })
  },
  search_files: {
    description: "Search file names and, optionally, UTF-8 text in a project. Narrow path or query if the result is truncated.",
    readOnly: true,
    input: z.object({ agent, ...target, path: directory, query: z.string().trim().min(1).max(500),
      limit: page.limit, includeContent: z.boolean().default(true) })
  },
  read_file: {
    description: "Read a project file. Text mode returns UTF-8 or extracts text from PDF and DOCX, at most 24000 characters per page. Base64 mode returns original bytes and may request up to 1 MiB per page. sha256 is always the full file. Continue with nextOffset and that sha256 so later pages stay on the same version.",
    readOnly: true,
    input: z.object({ agent, ...file, encoding: z.enum(["text", "base64"]).default("text"), offset, limit: readLimit,
      expectedHash: sha256.optional(), pageStart: z.number().int().min(1).max(10_000).optional() })
  },
  write_file: {
    description: "Create a file or replace its contents. For a new file omit expectedHash. To replace one, read it first and supply its sha256. Use base64 for original binary bytes.",
    readOnly: false,
    input: z.object({ agent, ...file, encoding: z.enum(["text", "base64"]).default("text"),
      content: z.string().max(Math.ceil(maxWriteBytes / 3) * 4), expectedHash: sha256.optional() })
  },
  patch_file: {
    description: "Replace exact, unique passages in a UTF-8 file, guarded by the sha256 returned by read_file. Use this for targeted edits.",
    readOnly: false,
    input: z.object({ agent, ...file, expectedHash: sha256,
      edits: z.array(z.object({ oldText: z.string().min(1).max(250_000), newText: z.string().max(250_000) })).min(1).max(50) })
  }
} as const;

export type ProjectMcpTool = keyof typeof projectMcpTools;
export type ProjectMcpInput<T extends ProjectMcpTool> = z.output<(typeof projectMcpTools)[T]["input"]>;
export const projectMcpCall = z.object({ tool: z.string(), input: z.unknown() }).strict();

export function isProjectMcpTool(name: string): name is ProjectMcpTool {
  return Object.hasOwn(projectMcpTools, name);
}
