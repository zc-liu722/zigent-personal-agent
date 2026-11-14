import { readFile } from "node:fs/promises";

/** Capture the immutable package identity at startup, before current is moved. */
export async function releaseCommit(): Promise<string | undefined> {
  try {
    const metadata = JSON.parse(await readFile(new URL("../../release.json", import.meta.url), "utf8"));
    return /^[a-f0-9]{40}$/.test(metadata.commit ?? "") ? metadata.commit : undefined;
  } catch { return undefined; }
}
