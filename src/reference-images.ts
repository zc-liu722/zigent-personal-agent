import type { StoredImageSource, ReferenceImage } from "./image-generation.js";

const DEFAULT_TTL_MS = 30 * 60_000;
const DEFAULT_MAX_IMAGES = 16;
const DEFAULT_MAX_TOTAL_BYTES = 80 * 1024 * 1024;

type PendingImages = {
  images: ReferenceImage[];
  updatedAt: number;
};

export class ReferenceImageStore {
  private readonly pending = new Map<string, PendingImages>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxImages = DEFAULT_MAX_IMAGES,
    private readonly maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES
  ) {}

  add(key: string, images: readonly ReferenceImage[], now = Date.now()): readonly ReferenceImage[] {
    const existing = this.getEntry(key, now)?.images ?? [];
    const combined = [...existing];
    for (const image of images) {
      const sourceKey = image.source ? ReferenceImageStore.sourceKey(image.source) : undefined;
      const duplicate = sourceKey
        ? combined.findIndex((candidate) => candidate.source && ReferenceImageStore.sourceKey(candidate.source) === sourceKey)
        : -1;
      if (duplicate >= 0) combined.splice(duplicate, 1);
      combined.push(image);
    }
    return this.store(key, combined, now);
  }

  replace(key: string, images: readonly ReferenceImage[], now = Date.now()): readonly ReferenceImage[] {
    return this.store(key, [...images], now);
  }

  get(key: string, now = Date.now()): readonly ReferenceImage[] {
    return [...(this.getEntry(key, now)?.images ?? [])];
  }

  clear(key: string): void {
    this.pending.delete(key);
  }

  clearPrefix(prefix: string): void {
    for (const key of this.pending.keys()) {
      if (key.startsWith(prefix)) this.pending.delete(key);
    }
  }

  static sourceKey(source: StoredImageSource): string {
    return `${source.provider}\0${source.messageId}\0${source.imageKey}`;
  }

  private store(key: string, images: ReferenceImage[], now: number): readonly ReferenceImage[] {
    while (images.length > this.maxImages
      || images.reduce((total, image) => total + image.data.byteLength, 0) > this.maxTotalBytes) images.shift();
    this.pending.set(key, { images, updatedAt: now });
    return [...images];
  }

  private getEntry(key: string, now: number): PendingImages | undefined {
    const entry = this.pending.get(key);
    if (!entry) return undefined;
    if (now - entry.updatedAt <= this.ttlMs) return entry;
    this.pending.delete(key);
    return undefined;
  }
}
