import type { Environment } from "./types.js";

export function requiredEnv(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Missing required configuration: ${name}`);
  return value;
}

export function optionalEnv(environment: Environment, name: string): string | undefined {
  const value = environment[name]?.trim();
  return value || undefined;
}

export function positiveInteger(environment: Environment, name: string, fallback: number): number {
  const raw = optionalEnv(environment, name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid environment configuration: ${name} must be a positive integer`);
  }
  return value;
}

export function reusableZenmuxApiKey(environment: Environment, prefix: string): string | undefined {
  const agentKeys = Object.keys(environment)
    .filter((name) => /^[A-Z][A-Z0-9_]*_ZENMUX_API_KEY$/.test(name))
    .sort();
  const names = [
    `${prefix}_ZENMUX_IMAGE_API_KEY`,
    "ZENMUX_API_KEY",
    `${prefix}_ZENMUX_API_KEY`,
    ...agentKeys
  ];
  return [...new Set(names)]
    .map((name) => optionalEnv(environment, name))
    .find((value): value is string => Boolean(value));
}

export function validUrl(value: string, name: string): string {
  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`Invalid configuration: ${name} must be a URL`);
  }
}
