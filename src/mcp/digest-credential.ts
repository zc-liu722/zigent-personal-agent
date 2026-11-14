import { createHash, timingSafeEqual } from "node:crypto";
import { open } from "node:fs/promises";

/** Compare a client credential with its independently provisioned digest. */
export async function matchesMcpCredential(file: string, credential: string | undefined): Promise<boolean> {
  if (typeof credential !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(credential)) return false;
  try {
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(67);
      const { bytesRead } = await handle.read(buffer);
      const digest = buffer.subarray(0, bytesRead).toString("ascii").trim();
      return bytesRead <= 66 && /^[0-9a-f]{64}$/.test(digest)
        && timingSafeEqual(Buffer.from(digest, "hex"), createHash("sha256").update(credential).digest());
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}
