import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { TosClient } from "@volcengine/tos-sdk";
import type { WebChannelConfig } from "../config.js";
import { prepareSql, sqliteTransaction } from "../sqlite.js";
import type { WebStore } from "./store.js";

const ENDPOINT = "https://openspeech-direct.zijieapi.com/api/v3/auc/bigmodel/";
const MAX_WAIT_MS = 3 * 60 * 60 * 1000;
type Saved = { taskId: string; key?: string; phase: "uploading" | "submitting" | "pending" | "completed" | "failed";
  startedAt: number; transcriptId?: string; logId?: string };
type Result = { audio_info?: { duration?: number }; result?: { text?: string;
  utterances?: Array<{ text?: string; start_time?: number; end_time?: number; additions?: { speaker?: string | number } }> } };

/** Same standard Seed ASR route as xiaoyuzhou; only temporary signed TOS URLs leave the server.
 * Protocol: https://docs.volcengine.com/docs/DoubaoVoice/task-submission-http-1?lang=zh
 * Formats: https://docs.volcengine.com/docs/doubao-voice/access-must-read-1?lang=zh
 */
export class WebAudioTranscriptions {
  private readonly client?: TosClient;
  private readonly pending = new Map<string, Promise<string>>();
  private readonly cleanupTimer: NodeJS.Timeout;
  private cleaning = false;
  constructor(private readonly store: WebStore, private readonly config: WebChannelConfig["transcription"]) {
    store.db.exec("CREATE TABLE IF NOT EXISTS audio_transcriptions (asset_id TEXT PRIMARY KEY, payload TEXT NOT NULL)");
    if (config) this.client = new TosClient({ ...config.tos, requestTimeout: 10000, connectionTimeout: 10000 });
    this.cleanupTimer = setInterval(() => { void this.cleanupAbandoned(); }, 10 * 60 * 1000);
    this.cleanupTimer.unref();
    void this.cleanupAbandoned();
  }
  close() { clearInterval(this.cleanupTimer); }
  private async cleanupAbandoned() {
    if (this.cleaning || !this.client) return;
    this.cleaning = true;
    try {
      const rows = prepareSql(this.store.db, "SELECT asset_id,payload FROM audio_transcriptions WHERE json_extract(payload,'$.key') IS NOT NULL").all() as Array<{ asset_id: string; payload: string }>;
      for (const row of rows) {
        if (this.pending.has(row.asset_id)) continue;
        const saved = JSON.parse(row.payload) as Saved;
        if (["completed", "failed"].includes(saved.phase) || Date.now() - saved.startedAt > MAX_WAIT_MS) await this.cleanup(row.asset_id, saved);
      }
    } catch { /* A closing database or temporary storage outage is retried on the next sweep. */ }
    finally { this.cleaning = false; }
  }
  async transcribe(id: string, signal: AbortSignal, progress: (text: string) => void): Promise<string> {
    // Serialize the same recording across conversations, preserving the saved provider task.
    const previous = this.pending.get(id);
    if (previous) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) { abort(); return; }
        void previous.catch(() => {}).then(() => { signal.removeEventListener("abort", abort); resolve(); });
      });
      return this.transcribe(id, signal, progress);
    }
    signal.throwIfAborted();
    const work = this.run(id, signal, progress);
    this.pending.set(id, work);
    try { return await work; }
    finally { if (this.pending.get(id) === work) this.pending.delete(id); }
  }
  private saved(id: string): Saved | undefined {
    const row = prepareSql(this.store.db, "SELECT payload FROM audio_transcriptions WHERE asset_id=?").get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as Saved : undefined;
  }
  private save(id: string, value: Saved) {
    prepareSql(this.store.db, "INSERT INTO audio_transcriptions VALUES (?,?) ON CONFLICT(asset_id) DO UPDATE SET payload=excluded.payload")
      .run(id, JSON.stringify(value));
  }
  private async cleanup(id: string, saved: Saved) {
    if (!saved.key || !this.client || !this.config) return;
    try {
      await this.client.deleteObject({ bucket: this.config.tos.bucket, key: saved.key });
      prepareSql(this.store.db, "UPDATE audio_transcriptions SET payload=json_remove(payload,'$.key') WHERE asset_id=? AND json_extract(payload,'$.taskId')=? AND json_extract(payload,'$.key')=?")
        .run(id, saved.taskId, saved.key);
      delete saved.key;
    } catch { /* Keep the object key for a later retry; never log signed URLs or credentials. */ }
  }
  private async request(action: "submit" | "query", saved: Saved, input: object, signal: AbortSignal) {
    const response = await fetch(ENDPOINT + action, { method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      headers: { "Content-Type": "application/json", "X-Api-Key": this.config!.apiKey, "X-Api-Resource-Id": "volc.seedasr.auc",
        "X-Api-Request-Id": saved.taskId, "X-Api-Sequence": "-1", ...(saved.logId ? { "X-Tt-Logid": saved.logId } : {}) },
      body: JSON.stringify(input) });
    const code = response.headers.get("X-Api-Status-Code") ?? "";
    saved.logId = response.headers.get("X-Tt-Logid") ?? saved.logId;
    if (!response.ok) { await response.body?.cancel(); throw new Error(`录音转录服务连接失败（HTTP ${response.status}），请重试。`); }
    // Responses may contain private transcript text; bound them and never log the body.
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) throw new Error("转录结果过长，请将录音分段后重试。");
      chunks.push(chunk);
    }
    return { code, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Result };
  }
  private async run(id: string, signal: AbortSignal, progress: (text: string) => void): Promise<string> {
    let saved = this.saved(id);
    if (saved?.transcriptId) { void this.cleanup(id, saved); return saved.transcriptId; }
    if (!this.config || !this.client) throw new Error("录音转录尚未配置，请联系管理员后重试。");
    signal.throwIfAborted();
    const source = this.store.asset(id), name = this.store.documentMetadata([id])[id]?.name;
    if (!source?.mime.startsWith("audio/") || !name) throw new Error("录音附件不存在，请重新上传。");
    if (saved?.phase === "failed" || saved && Date.now() - saved.startedAt > MAX_WAIT_MS) {
      await this.cleanup(id, saved);
      if (saved.key) throw new Error("临时录音清理失败，请稍后重试。");
      saved = undefined;
    }
    if (!saved) {
      const taskId = randomUUID();
      saved = { taskId, key: `zigent-asr/${taskId}.${name.split(".").at(-1)!.toLowerCase()}`, phase: "uploading", startedAt: Date.now() };
      this.save(id, saved);
    }
    if (saved.phase === "uploading") {
      progress("正在准备录音…");
      const url = this.client.getPreSignedUrl({ bucket: this.config.tos.bucket, key: saved.key!, method: "PUT", expires: 600 });
      const uploaded = await fetch(url, { method: "PUT", body: Buffer.from(source.bytes),
        headers: { "Content-Type": source.mime }, signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]) });
      await uploaded.body?.cancel();
      if (!uploaded.ok) throw new Error("录音临时上传失败，请重试。");
      signal.throwIfAborted();
      saved.phase = "submitting"; this.save(id, saved);
      const publicUrl = this.client.getPreSignedUrl({ bucket: this.config.tos.bucket, key: saved.key!, method: "GET", expires: 6 * 60 * 60 });
      // Persist before submission. If its acknowledgement is lost, retries query this task rather than charging for a new one.
      const submitted = await this.request("submit", saved, { user: { uid: "zigent" },
        audio: { url: publicUrl, format: name.split(".").at(-1)!.toLowerCase() },
        request: { model_name: "bigmodel", ssd_version: "200", enable_itn: true, enable_punc: true,
          enable_speaker_info: true, show_utterances: true } }, signal);
      if (submitted.code !== "20000000") {
        saved.phase = "failed"; this.save(id, saved); await this.cleanup(id, saved);
        throw new Error(`录音转录提交失败（${submitted.code || "未知状态"}），请重试。`);
      }
      saved.phase = "pending"; this.save(id, saved);
    }
    progress("正在转录录音…");
    let failures = 0, pendingPolls = 0;
    while (Date.now() - saved.startedAt < MAX_WAIT_MS) {
      signal.throwIfAborted();
      let response: Awaited<ReturnType<WebAudioTranscriptions["request"]>>;
      try { response = await this.request("query", saved, {}, signal); failures = 0; }
      catch (error) {
        signal.throwIfAborted();
        if (++failures > 8) throw error;
        await delay(Math.min(15000, 1000 * 2 ** (failures - 1)), undefined, { signal }); continue;
      }
      this.save(id, saved);
      if (response.code === "20000000") {
        const result = response.body.result;
        const stamp = (ms = 0) => { const seconds = Math.floor(Math.max(0, ms) / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; };
        const segments = result?.utterances?.filter(item => typeof item.text === "string" && item.text.trim());
        const text = segments?.length ? segments.map(item => `[${stamp(item.start_time)}–${stamp(item.end_time)}]${item.additions?.speaker !== undefined ? ` 说话人 ${item.additions.speaker}` : ""} ${item.text!.trim()}`).join("\n") : result?.text?.trim();
        if (!text || Buffer.byteLength(text) > 2 * 1024 * 1024) {
          saved.phase = "failed"; this.save(id, saved); await this.cleanup(id, saved);
          throw new Error(text ? "转录结果过长，请将录音分段。" : "未识别到有效语音，请检查录音。");
        }
        signal.throwIfAborted();
        sqliteTransaction(this.store.db, () => {
          saved!.transcriptId = this.store.addAsset(Buffer.from(text), "text/plain; charset=utf-8", `${name.slice(0, 220)}.转录.txt`);
          saved!.phase = "completed"; this.save(id, saved!);
        });
        // The transcript is durable; do not delay the reply on best-effort object cleanup.
        // A retained key is retried by the existing cleanup sweep, including after restart.
        void this.cleanup(id, saved);
        return saved.transcriptId!;
      }
      if (!["20000001", "20000002"].includes(response.code)) {
        saved.phase = "failed"; this.save(id, saved); await this.cleanup(id, saved);
        throw new Error(response.code === "20000003" ? "未识别到有效语音，请检查录音。" : `录音转录失败（${response.code || "未知状态"}），请重试。`);
      }
      // One earlier check helps short recordings; from 3 seconds onward the
      // schedule matches the original cadence and does not keep polling faster.
      const waitMs = pendingPolls === 0 ? 1000 : pendingPolls === 1 ? 2000 : 3000;
      pendingPolls++;
      await delay(waitMs, undefined, { signal });
    }
    throw new Error("录音转录等待超时，请稍后重试。");
  }
}
