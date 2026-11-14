import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, open, rm, readdir, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Process-private transient ciphertext; keys never leave memory. No diagnostic recording. */
export class PcmSpool {
  private key = randomBytes(32);
  private nonce = randomBytes(16);
  private directory?: string;
  private file?: FileHandle;
  private written = 0;
  private consumed = 0;
  private pending = 0;
  private closed = false;
  private failure?: Error;
  private tail: Promise<void> = Promise.resolve();
  get bytes() { return this.written - this.consumed; }
  get pendingBytes() { return this.pending; }

  append(pcm: Buffer) {
    if (this.closed || this.failure || this.pending + pcm.length > 4 * 1024 * 1024) return false;
    this.pending += pcm.length;
    this.tail = this.tail.then(async () => {
      if (this.closed || this.failure) return;
      if (!this.file) {
        this.directory = await mkdtemp(join(tmpdir(), `zigent-call-audio-${process.pid}-`));
        this.file = await open(join(this.directory, 'pcm.enc'), 'wx+', 0o600);
      }
      if (this.closed) return;
      const encrypted = this.crypt(pcm, this.written);
      let offset = 0;
      while (offset < encrypted.length) {
        const result = await this.file.write(encrypted, offset, encrypted.length - offset, this.written + offset);
        if (!result.bytesWritten) throw new Error('spool_write');
        offset += result.bytesWritten;
      }
      this.written += pcm.length;
    }).catch(() => { this.failure = new Error('spool_io'); }).finally(() => { this.pending -= pcm.length; });
    return true;
  }

  async read(size: number) {
    await this.tail;
    if (this.failure) throw this.failure;
    if (this.closed || !this.file) return Buffer.alloc(0);
    const count = Math.min(size, this.bytes), data = Buffer.allocUnsafe(count);
    let offset = 0;
    while (offset < count) {
      const result = await this.file.read(data, offset, count - offset, this.consumed + offset);
      if (!result.bytesRead) throw new Error('spool_read');
      offset += result.bytesRead;
    }
    const pcm = this.crypt(data, this.consumed);
    this.consumed += count;
    return pcm;
  }

  private crypt(data: Buffer, offset: number) {
    const counter = Buffer.from(this.nonce);
    const base = (counter.readBigUInt64BE(0) << 64n) | counter.readBigUInt64BE(8);
    const block = (base + BigInt(Math.floor(offset / 16))) & ((1n << 128n) - 1n);
    counter.writeBigUInt64BE(block >> 64n, 0); counter.writeBigUInt64BE(block & ((1n << 64n) - 1n), 8);
    const cipher = createCipheriv('aes-256-ctr', this.key, counter);
    if (offset % 16) cipher.update(Buffer.alloc(offset % 16));
    return cipher.update(data);
  }

  async close() {
    this.closed = true;
    await this.tail;
    try { await this.file?.close(); }
    finally {
      this.key.fill(0); this.nonce.fill(0);
      if (this.directory) await rm(this.directory, { recursive: true, force: true });
    }
  }
}

/** Forced exits leave ciphertext only. Reap old directories only for dead processes. */
export async function cleanAbandonedSpools() {
  const root = tmpdir();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const match = /^zigent-call-audio-(\d+)-/.exec(entry.name);
    if (!entry.isDirectory() || !match) continue;
    const path = join(root, entry.name);
    try {
      if (Date.now() - (await stat(path)).mtimeMs < 3600_000) continue;
      try { process.kill(Number(match[1]), 0); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
      await rm(path, { recursive: true, force: true });
    } catch { /* Cleanup must not prevent a new call. */ }
  }
}
