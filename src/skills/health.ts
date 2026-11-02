import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export const HEALTH_SKILL_NAME = "health";
export const HEALTH_SKILL_DESCRIPTION = "私人健康项目：通用规则与个人当前状态分开维护，按日期查询健康数据和项目日记。";
export const HEALTH_SKILL_RULES = readFileSync(new URL("../../skills/health/SKILL.md", import.meta.url), "utf8");
export const HEALTH_RULES_DIGEST = createHash("sha256").update(HEALTH_SKILL_RULES).digest("hex");
export const DEFAULT_HEALTH_SKILL = `# 健康项目个人当前状态

## 健康基线
尚无确认的个人基线。

## 目标
尚无确认的目标。

## 当前计划
尚无确认的计划。

## 长期记忆
尚无确认的稳定偏好与限制。

## 近期状态
尚无近期状态。
`;

/** Remove only the known managed query contract; preserve unknown personal notes and fenced examples. */
export function privateHealthState(body: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  let fence: string | undefined, managed = false;
  for (const line of lines) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!fence && /^#{1,3} /.test(line)) managed = false;
    if (!fence && line === "### health_data 查询规范") managed = true;
    if (!managed) kept.push(line);
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
    }
  }
  // Remove empty managed headings using the same fence-aware traversal.
  const headings: { index: number; title: string }[] = [];
  fence = undefined;
  for (const [index, line] of kept.entries()) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!fence && /^#{1,2} /.test(line)) headings.push({ index, title: line });
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
    }
  }
  const remove = new Set<number>();
  for (const [offset, heading] of headings.entries()) {
    const end = headings[offset + 1]?.index ?? kept.length;
    if (["## 数据与分析方法", "## 项目工具说明", "## 项目记忆与待跟进"].includes(heading.title.trim()) && !kept.slice(heading.index + 1, end).join("\n").trim()) {
      for (let index = heading.index; index < end; index++) remove.add(index);
    }
  }
  return kept.filter((_line, index) => !remove.has(index)).join("\n");
}

/** One-time consolidation when migrating the old read-only rules deployment. */
export function consolidateHealthPreferences(body: string): string {
  const lines = body.split("\n");
  let fence: string | undefined, start = -1, end = lines.length;
  for (const [index, line] of lines.entries()) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    if (start >= 0 && /^#{1,2} /.test(line)) { end = index; break; }
    if (line === "## 跟进与修改方法") start = index;
  }
  if (start < 0) return body;
  lines.splice(start + 1, end - start - 1, "", "本项目的个人偏好见规则文件例外条款。", "");
  return lines.join("\n");
}

export function renderHealthSkill(state: { body: string; rules: string }): string {
  return `# 健康项目当前正文\n\n<!-- 当前视图；项目规则与个人状态通过 update_skill 分别维护。 -->\n\n${state.rules.trim()}\n\n---\n\n# 个人当前状态\n\n${state.body.trim()}\n`;
}
