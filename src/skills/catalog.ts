/** Public, immutable instruction/resource contract. It never grants tool access. */
export type PackagedSkill = {
  name: string; description: string; body: string; rules: string; revision: number;
  files: Readonly<Record<string, string>>; // package-relative base64 bytes
};
export type SkillCatalog = { version: string; entries: readonly PackagedSkill[] };
