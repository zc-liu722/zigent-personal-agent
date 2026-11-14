import { createHash } from "node:crypto";
import { z } from "zod";

export const skillSectionsSchema = z.array(z.object({
  heading: z.string().regex(/^#{1,6} [^\r\n]+$/), content: z.string().max(100_000)
}).strict()).min(1).max(20);

export const agentSkillName = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).refine(name => name === name.trim(), "Skill names cannot contain whitespace");
const content = z.string().max(100_000);
const common = { name: agentSkillName, expected_revision: z.number().int().nonnegative(), source_request_id: z.string().trim().min(1).max(120) };
const description = z.string().trim().min(1).max(500);
const target = z.enum(["body", "rules"]).optional();
const mutationSchema = z.discriminatedUnion("action", [
  z.object({ ...common, action: z.literal("create"), description, body: content.min(1), rules: content.optional() }).strict(),
  z.object({ ...common, action: z.literal("replace"), target, content, description: description.optional() }).strict(),
  z.object({ ...common, action: z.literal("delete") }).strict(),
  z.object({ ...common, action: z.literal("replace_sections"), target, sections: skillSectionsSchema }).strict(),
  z.object({ ...common, action: z.literal("replace_section"), target, heading: z.string(), content }).strict()
]);
export const parseAgentSkillMutation = (input: unknown) => mutationSchema.parse(input);
export type SkillMutation = z.infer<typeof mutationSchema>;

export function skillMutationDigest(input: SkillMutation) {
  return createHash("sha256").update(JSON.stringify({ ...input, expected_revision: undefined })).digest("hex");
}
