import { randomUUID } from "node:crypto";
import type { ElementHandle, Frame, JSHandle, Page } from "playwright-core";

type NativeEditor = HTMLInputElement | HTMLTextAreaElement;
type Bounds = { x: number; y: number; width: number; height: number };
export type BrowserEditor = {
  id: string; version: number; kind: string; inputMode: string; multiline: boolean; password: boolean; label: string; autocomplete?: string;
  value?: string; length: number; selectionStart?: number; selectionEnd?: number; bounds: Bounds;
  fontSize?: string; fontFamily?: string; color?: string; backgroundColor?: string;
};
type NativeState = Omit<BrowserEditor, "id" | "version" | "bounds" | "length"> & { value: string; selectable: boolean };
type Entry = { id: string; version: number; handle: ElementHandle<NativeEditor>; frame: Frame; value: string; kind: string; seenAt: number };
const stale = () => new Error("输入框已变化，请重新同步后输入");

/** Private controller-only editing state. Never include this in model observations. */
export class BrowserEditing {
  private page?: Page;
  private epoch = -1;
  private generation = 0;
  private entries = new Map<string, Entry>();
  private registries = new Map<Frame, JSHandle<WeakMap<Element, string>>>();

  reset(): void {
    this.generation++;
    for (const entry of this.entries.values()) void entry.handle.dispose().catch(() => {});
    for (const registry of this.registries.values()) void registry.dispose().catch(() => {});
    this.entries.clear(); this.registries.clear(); this.page = undefined; this.epoch = -1;
  }

  private async read(handle: ElementHandle<NativeEditor>): Promise<NativeState | undefined> {
    return await handle.evaluate(node => {
      const allowed = new Set(["text", "search", "tel", "url", "email", "number", "password"]);
      const multiline = node.tagName === "TEXTAREA", kind = multiline ? "textarea" : (node as HTMLInputElement).type;
      const box = node.getBoundingClientRect(), style = getComputedStyle(node);
      if (!node.isConnected || node.value.length > 16000 || node.disabled || node.matches(':disabled') || node.closest('[inert]') || node.readOnly || !multiline && !allowed.has(kind) || !box.width || !box.height
        || style.visibility !== "visible" || style.display === "none" || Number(style.opacity) === 0) return undefined;
      let ancestor: Element | null = node.parentElement;
      while (ancestor) {
        const css = getComputedStyle(ancestor);
        if (css.display === "none" || css.visibility !== "visible" || Number(css.opacity) === 0) return undefined;
        ancestor = ancestor.parentElement;
      }
      const start = node.selectionStart, end = node.selectionEnd;
      const inputMode = node.inputMode || ({ email: "email", tel: "tel", url: "url", search: "search", number: "decimal" } as Record<string, string>)[kind] || "text";
      return { kind, inputMode, multiline, password: kind === "password", value: node.value, selectable: typeof start === "number" && typeof end === "number",
        ...(typeof start === "number" ? { selectionStart: start } : {}), ...(typeof end === "number" ? { selectionEnd: end } : {}),
        label: (node.getAttribute("aria-label") || node.labels?.[0]?.textContent || node.placeholder || node.name || "输入框").trim().slice(0, 140),
        autocomplete: node.autocomplete?.slice(0, 100) || undefined,
        fontSize: style.fontSize, fontFamily: style.fontFamily.slice(0, 160), color: style.color, backgroundColor: style.backgroundColor };
    }).catch(() => undefined);
  }

  private async visibleBounds(handle: ElementHandle<NativeEditor>, page: Page): Promise<Bounds | undefined> {
    const bounds = await handle.boundingBox().catch(() => null), viewport = page.viewportSize();
    if (!bounds || !viewport) return;
    let left = Math.max(0, bounds.x), top = Math.max(0, bounds.y), right = Math.min(viewport.width, bounds.x + bounds.width), bottom = Math.min(viewport.height, bounds.y + bounds.height);
    // Child-frame boxes are already in main-frame coordinates; clip to every iframe.
    let frame = await handle.ownerFrame();
    while (frame?.parentFrame()) {
      const iframe = await frame.frameElement().catch(() => undefined);
      const parentBounds = await iframe?.boundingBox().catch(() => null);
      await iframe?.dispose();
      if (!parentBounds) return;
      left = Math.max(left, parentBounds.x); top = Math.max(top, parentBounds.y);
      right = Math.min(right, parentBounds.x + parentBounds.width); bottom = Math.min(bottom, parentBounds.y + parentBounds.height);
      frame = frame.parentFrame();
    }
    if (right <= left || bottom <= top) return;
    // An input's bounding box can include overlaid controls (SMS buttons,
    // country selectors, password toggles). A full-box local editor would steal
    // their taps, which focusTarget correctly rejects as an obscured input.
    // Find a clear editing rectangle; leave the other areas on the image path.
    const clear = await handle.evaluate((node, clip) => {
      const box = node.getBoundingClientRect();
      let area = { left: box.left + clip.left * box.width, top: box.top + clip.top * box.height,
        right: box.left + clip.right * box.width, bottom: box.top + clip.bottom * box.height };
      const center = { x: (area.left + area.right) / 2, y: (area.top + area.bottom) / 2 };
      const blockers = new Set<Element>();
      // Bound work on large textareas. Inspect the hit stack so a nested label
      // also excludes its surrounding clickable control, including its padding.
      const columns = Math.min(32, Math.max(1, Math.ceil((area.right - area.left) / 24)));
      const rows = Math.min(8, Math.max(1, Math.ceil((area.bottom - area.top) / 24)));
      for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
        const x = area.left + (column + .5) / columns * (area.right - area.left);
        const y = area.top + (row + .5) / rows * (area.bottom - area.top);
        for (const hit of node.ownerDocument.elementsFromPoint(x, y)) {
          if (hit === node) break;
          if (!hit.contains(node)) blockers.add(hit);
        }
      }
      for (const blocker of blockers) for (const rect of blocker.getClientRects()) {
        if (rect.right <= area.left || rect.left >= area.right || rect.bottom <= area.top || rect.top >= area.bottom) continue;
        const choices = [{ ...area, right: Math.min(area.right, rect.left) }, { ...area, left: Math.max(area.left, rect.right) },
          { ...area, bottom: Math.min(area.bottom, rect.top) }, { ...area, top: Math.max(area.top, rect.bottom) }]
          .filter(candidate => candidate.left <= center.x && candidate.right > center.x && candidate.top <= center.y && candidate.bottom > center.y)
          .sort((a, b) => (b.right - b.left) * (b.bottom - b.top) - (a.right - a.left) * (a.bottom - a.top));
        if (!choices.length) return;
        area = choices[0];
      }
      return { left: (area.left - box.left) / box.width, top: (area.top - box.top) / box.height,
        right: (area.right - box.left) / box.width, bottom: (area.bottom - box.top) / box.height };
    }, { left: (left - bounds.x) / bounds.width, top: (top - bounds.y) / bounds.height,
      right: (right - bounds.x) / bounds.width, bottom: (bottom - bounds.y) / bounds.height }).catch(() => undefined);
    if (!clear) return;
    return { x: bounds.x + clear.left * bounds.width, y: bounds.y + clear.top * bounds.height,
      width: (clear.right - clear.left) * bounds.width, height: (clear.bottom - clear.top) * bounds.height };
  }

  private update(entry: Entry, state: NativeState): void {
    if (entry.value !== state.value || entry.kind !== state.kind) entry.version++;
    entry.value = state.value; entry.kind = state.kind; entry.seenAt = Date.now();
  }

  private snapshot(entry: Entry, state: NativeState, bounds: Bounds): BrowserEditor {
    const { value, selectable: _selectable, ...safe } = state;
    return { ...safe, id: entry.id, version: entry.version, bounds, length: value.length, ...(!state.password ? { value } : {}) };
  }

  private async hit<T extends Element>(handle: ElementHandle<T>, point: { x: number; y: number }): Promise<boolean> {
    const box = await handle.boundingBox().catch(() => null);
    if (!box || point.x < box.x || point.y < box.y || point.x >= box.x + box.width || point.y >= box.y + box.height) return false;
    return await handle.evaluate((node, offset) => {
      let ancestor: Element | null = node;
      while (ancestor) {
        const style = getComputedStyle(ancestor);
        if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
        const root = ancestor.getRootNode();
        ancestor = ancestor.parentElement || (root instanceof ShadowRoot ? root.host : null);
      }
      const box = node.getBoundingClientRect(), x = box.x + box.width * offset.x, y = box.y + box.height * offset.y;
      let hit = node.ownerDocument.elementFromPoint(x, y);
      while (hit?.shadowRoot) {
        const inner = hit.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === hit) break; hit = inner;
      }
      return hit === node;
    }, { x: (point.x - box.x) / box.width, y: (point.y - box.y) / box.height }).catch(() => false);
  }

  private async unobscured(handle: ElementHandle<NativeEditor>, point: { x: number; y: number }): Promise<boolean> {
    if (!await this.hit(handle, point)) return false;
    let frame = await handle.ownerFrame();
    while (frame?.parentFrame()) {
      const host = await frame.frameElement().catch(() => undefined);
      if (!host) return false;
      const hit = await this.hit(host as ElementHandle<Element>, point);
      await host.dispose(); if (!hit) return false;
      frame = frame.parentFrame();
    }
    return true;
  }

  async collect(page: Page, epoch: number, valid: () => boolean): Promise<BrowserEditor[]> {
    if (this.page !== page || this.epoch !== epoch) { this.reset(); this.page = page; this.epoch = epoch; }
    const generation = this.generation, current = () => this.generation === generation && valid();
    const result: BrowserEditor[] = [];
    for (const frame of page.frames().slice(0, 12)) {
      if (!current()) return [];
      let registry = this.registries.get(frame);
      if (!registry || !await registry.evaluate(() => true).catch(() => false)) {
        registry = await frame.evaluateHandle(() => new WeakMap<Element, string>()).catch(() => undefined);
        if (!registry) continue;
        this.registries.set(frame, registry);
      }
      if (result.length >= 40) break;
      // Filter in the browser before creating cross-process handles or reading values.
      const candidates = await frame.evaluateHandle(() => {
        const allowed = new Set(["text", "search", "tel", "url", "email", "number", "password"]), result: Element[] = [];
        for (const element of document.querySelectorAll('input:not([disabled]):not([readonly]),textarea:not([disabled]):not([readonly])')) {
          const node = element as HTMLInputElement | HTMLTextAreaElement, box = node.getBoundingClientRect(), style = getComputedStyle(node);
          if (node.value.length > 16000 || node.matches(':disabled') || node.closest('[inert]') || node.tagName !== 'TEXTAREA' && !allowed.has((node as HTMLInputElement).type)
            || box.width <= 0 || box.height <= 0 || box.right <= 0 || box.bottom <= 0 || box.left >= innerWidth || box.top >= innerHeight
            || style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) continue;
          const x = (Math.max(0, box.left) + Math.min(innerWidth, box.right)) / 2, y = (Math.max(0, box.top) + Math.min(innerHeight, box.bottom)) / 2;
          let hit = document.elementFromPoint(x, y);
          while (hit?.shadowRoot) { const inner = hit.shadowRoot.elementFromPoint(x, y); if (!inner || inner === hit) break; hit = inner; }
          if (hit !== node) continue;
          result.push(node); if (result.length >= 40) break;
        }
        return result;
      }).catch(() => undefined);
      if (!candidates) continue;
      const properties = await candidates.getProperties().catch(() => new Map<string, JSHandle>());
      await candidates.dispose();
      for (const property of properties.values()) {
        const element = property.asElement();
        if (!element) { await property.dispose(); continue; }
        const handle = element as ElementHandle<NativeEditor>;
        if (result.length >= 40 || !current()) { await handle.dispose(); continue; }
        const state = await this.read(handle), bounds = state && await this.visibleBounds(handle, page);
        if (!state || !bounds || !await this.unobscured(handle, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 })) { await handle.dispose(); continue; }
        const candidate = randomUUID();
        let id = await handle.evaluate((node, { registry, candidate }) => {
          const id = registry.get(node) || candidate; registry.set(node, id); return id;
        }, { registry, candidate }).catch(() => undefined);
        if (!id || !current()) { await handle.dispose(); continue; }
        let entry = this.entries.get(id);
        // Expired entries get a fresh identity, never a reused version counter.
        if (!entry && id !== candidate) {
          id = candidate;
          await handle.evaluate((node, { registry, id }) => registry.set(node, id), { registry, id });
        }
        if (!entry) {
          entry = { id, version: 1, handle, frame, value: state.value, kind: state.kind, seenAt: Date.now() };
          this.entries.set(id, entry);
        } else { this.update(entry, state); await handle.dispose(); }
        result.push(this.snapshot(entry, state, bounds));
      }
    }
    for (const [id, entry] of this.entries) if (Date.now() - entry.seenAt > 300000 || this.entries.size > 240) {
      this.entries.delete(id); void entry.handle.dispose().catch(() => {});
    }
    return current() ? result : [];
  }

  private async target(page: Page, epoch: number, id: string): Promise<{ entry: Entry; state: NativeState }> {
    const entry = this.entries.get(id);
    if (this.page !== page || this.epoch !== epoch || !entry || Date.now() - entry.seenAt > 300000 || entry.frame.isDetached()) throw stale();
    const state = await this.read(entry.handle), bounds = state && await this.visibleBounds(entry.handle, page);
    if (!state || !bounds || !await this.unobscured(entry.handle, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 })) throw stale();
    return { entry, state };
  }

  private async focused(entry: Entry): Promise<boolean> {
    if (!await entry.handle.evaluate(node => {
      let active = node.ownerDocument.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      return active === node;
    }).catch(() => false)) return false;
    let frame = entry.frame;
    while (frame.parentFrame()) {
      const host = await frame.frameElement().catch(() => undefined);
      if (!host) return false;
      const active = await host.evaluate(node => {
        let active = node.ownerDocument?.activeElement;
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
        return active === node;
      }).catch(() => false);
      await host.dispose(); if (!active) return false;
      frame = frame.parentFrame()!;
    }
    return true;
  }

  private async interaction(page: Page, valid: () => boolean, operation: (current: () => boolean) => Promise<void>): Promise<void> {
    let interrupted = false, rejectDialog: (reason: Error) => void = () => {};
    const dialog = new Promise<never>((_resolve, reject) => { rejectDialog = reject; });
    const onDialog = () => { interrupted = true; rejectDialog(stale()); };
    page.on("dialog", onDialog);
    try {
      // Native input listeners can open a JS modal while Playwright is waiting
      // for the input event to finish. Release the queue so it can dismiss it.
      await Promise.race([operation(() => !interrupted && valid()), dialog]);
    } finally { page.off("dialog", onDialog); }
  }

  async focus(page: Page, epoch: number, id: string, point: { x: number; y: number } | undefined, valid: () => boolean): Promise<void> {
    return this.interaction(page, valid, current => this.focusTarget(page, epoch, id, point, current));
  }

  private async focusTarget(page: Page, epoch: number, id: string, point: { x: number; y: number } | undefined, valid: () => boolean): Promise<void> {
    const { entry } = await this.target(page, epoch, id);
    if (point) {
      if (!await this.unobscured(entry.handle, point)) throw stale();
      if (!valid()) throw stale();
      await page.mouse.click(point.x, point.y);
    } else {
      const box = await this.visibleBounds(entry.handle, page);
      if (!box || !await this.unobscured(entry.handle, { x: box.x + box.width / 2, y: box.y + box.height / 2 })) throw stale();
      if (!valid()) throw stale();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    if (!valid() || !await this.focused(entry)) throw stale();
    const next = await this.read(entry.handle); if (!next) throw stale(); this.update(entry, next);
  }

  async verifyFocus(page: Page, epoch: number, id: string): Promise<void> {
    const { entry } = await this.target(page, epoch, id);
    if (!await this.focused(entry)) throw stale();
  }

  async edit(page: Page, epoch: number, input: { editorId: string; editorVersion: number; editStart: number; editEnd: number; text: string; expectedLength: number }, valid: () => boolean): Promise<void> {
    return this.interaction(page, valid, current => this.editTarget(page, epoch, input, current));
  }

  private async editTarget(page: Page, epoch: number, input: { editorId: string; editorVersion: number; editStart: number; editEnd: number; text: string; expectedLength: number }, valid: () => boolean): Promise<void> {
    const { entry, state } = await this.target(page, epoch, input.editorId);
    if (!valid() || entry.version !== input.editorVersion || state.value !== entry.value || state.kind !== entry.kind || state.value.length !== input.expectedLength
      || input.editStart > input.editEnd || input.editEnd > state.value.length || !await this.focused(entry)) throw stale();
    const expected = state.value.slice(0, input.editStart) + input.text + state.value.slice(input.editEnd);
    if (expected.length > 16000) throw stale();
    if (state.selectable) {
      await entry.handle.evaluate((node, range) => node.setSelectionRange(range.start, range.end), { start: input.editStart, end: input.editEnd });
      if (!valid() || !await this.focused(entry)) throw stale();
      if (input.text) await page.keyboard.insertText(input.text);
      else if (input.editEnd > input.editStart) await page.keyboard.press("Backspace");
    } else {
      if (!valid() || !await this.focused(entry)) throw stale();
      await entry.handle.fill(expected);
    }
    if (!valid()) throw stale();
    const actual = await this.read(entry.handle);
    if (!actual) throw stale();
    // Successful user operations always advance the editing revision, even a no-op.
    entry.version++; entry.value = actual.value; entry.kind = actual.kind; entry.seenAt = Date.now();
    if (actual.value !== expected) throw stale();
  }
}
