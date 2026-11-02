import type { AgentRunChannel, DeliveredImage } from "../channels/types.js";
import type { AgentEvent } from "./events.js";
import { AgentTranscript, type AgentRunSnapshot } from "./transcript.js";
import type { GeneratedImage } from "../image-generation.js";
import type { GeneratedVideo } from "../video-generation.js";
import { conversationOutputSchema, type ConversationOutput } from "../channels/output.js";
import { AgentRunInterruption } from "./interruption.js";
import { currentPerformance } from "../performance/store.js";

export class AgentRunSession {
  private readonly transcript: AgentTranscript;
  private readonly outputIds = new Set<string>();
  private readonly fileOutputIds = new Set<string>();
  private readonly imageDeliveries = new Map<GeneratedImage, DeliveredImage | undefined>();
  private hasVisibleText = false;

  constructor(private readonly channel: AgentRunChannel) {
    this.transcript = new AgentTranscript(Boolean(channel.updateActivitySource));
  }

  async open(): Promise<void> {
    await this.channel.openActivity(this.transcript.snapshot());
  }

  receive(event: AgentEvent): void {
    if (event.type === "model.route" && (event.status === "connecting" || event.status === "connected")) return;
    if (event.type === "visual.preparing") {
      if (!this.hasVisibleText) this.receive({ type: "response.completed", itemId: event.itemId, role: "commentary",
        text: "正在制作可视化内容。" });
      return;
    }
    if (event.type === "tool.started" && !this.hasVisibleText && (event.name === "image_generation" || event.name === "video_generation")) {
      this.receive({ type: "response.completed", itemId: `media-preparation:${event.itemId}`, role: "commentary",
        text: event.name === "image_generation" ? "正在准备生成图片。" : "正在准备生成视频。" });
    }
    if (event.type === "tool.started" && event.name === "health_data" && !this.hasVisibleText
      && !event.presentation.hidden && event.presentation.message.trim()) {
      this.receive({ type: "response.completed", itemId: `health-preparation:${event.itemId}`, role: "commentary",
        text: event.presentation.message });
    }
    if (event.type === "model.route") this.hasVisibleText = true;
    if ((event.type === "response.delta" || event.type === "response.completed") && event.text.trim()) this.hasVisibleText = true;
    this.transcript.advance(event);
    const publication = this.channel.updateActivitySource
      ? this.channel.updateActivitySource(this.transcript.activityUpdate())
      : this.channel.updateActivity(this.transcript.snapshot());
    void publication.catch((error: unknown) => {
      console.warn("Unable to publish agent activity update", error);
    });
  }

  auditSnapshot(): AgentRunSnapshot {
    return this.transcript.snapshot();
  }

  get supportsOutput(): boolean { return Boolean(this.channel.sendOutput); }
  get replyId(): string | undefined { return this.channel.replyId; }
  get supportsImages(): boolean { return Boolean(this.channel.sendImages); }

  async presentImages(images: readonly GeneratedImage[], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.transcript.snapshot().status !== "running") throw new Error("This run cannot publish images");
    await this.deliverImages(images);
  }

  private async deliverImages(images: readonly GeneratedImage[]): Promise<readonly DeliveredImage[]> {
    const pending = images.filter(image => !this.imageDeliveries.has(image));
    if (pending.length && this.channel.sendImages) {
      const measurement = currentPerformance();
      const send = () => this.channel.sendImages!(pending);
      const deliveries = await (measurement ? measurement.store.measure("media.image_delivery", "web", send) : send()) ?? [];
      pending.forEach((image, index) => this.imageDeliveries.set(image, deliveries[index]));
    }
    return images.flatMap(image => {
      const delivery = this.imageDeliveries.get(image);
      return delivery ? [delivery] : [];
    });
  }

  async presentOutput(output: ConversationOutput, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.transcript.snapshot().status !== "running" || !this.channel.sendOutput) throw new Error("This run cannot publish visual output");
    const ids = output.blocks.every(block=>block.type==="artifact") ? this.fileOutputIds : this.outputIds;
    if (!ids.has(output.id) && ids.size >= (ids===this.fileOutputIds?100:6)) throw new Error("Too many outputs in this reply");
    await this.channel.sendOutput(conversationOutputSchema.parse(output));
    ids.add(output.id);
  }

  async complete(
    finalReply: string,
    images: readonly GeneratedImage[] = [],
    videos: readonly GeneratedVideo[] = [],
    signal?: AbortSignal
  ): Promise<readonly DeliveredImage[]> {
    signal?.throwIfAborted();
    const snapshot = this.transcript.complete(finalReply);
    await this.publishTerminal(snapshot);
    signal?.throwIfAborted();
    await this.channel.sendFinalReply(finalReply);
    signal?.throwIfAborted();
    const deliveries = await this.deliverImages(images);
    signal?.throwIfAborted();
    if (videos.length > 0 && this.channel.sendVideos) await this.channel.sendVideos(videos);
    return deliveries;
  }

  async fail(message: string): Promise<void> {
    const snapshot = this.transcript.fail(message);
    await this.publishTerminal(snapshot);
    await this.channel.sendFailure(message);
  }

  private async publishTerminal(snapshot: AgentRunSnapshot): Promise<void> {
    if (this.channel.updateActivitySource) await this.channel.updateActivitySource(this.transcript.activityUpdate());
    else await this.channel.updateActivity(snapshot);
  }

  async cancel(reason?: unknown): Promise<void> {
    // A service interruption is a retryable failure, not the user's Stop action.
    // Publish on the existing reply without replacing its partial answer/assets.
    await this.publishTerminal(reason instanceof AgentRunInterruption && reason.kind === "service_shutdown"
      ? this.transcript.fail(reason.message) : this.transcript.cancel());
  }
}
