import type { AgentActivityUpdate, AgentRunSnapshot } from "../agent/transcript.js";
import type { GeneratedImage } from "../image-generation.js";
import type { GeneratedVideo } from "../video-generation.js";
import type { ConversationOutput } from "./output.js";

export type DeliveredImage = {
  provider: "web";
  messageId: string;
  imageKey: string;
  generationId?: string;
  sha256?: string;
  experimentId?: string;
  variant?: GeneratedImage["variant"];
  ordinal?: number;
};

export interface AgentRunChannel {
  readonly replyId?: string;
  openActivity(snapshot: AgentRunSnapshot): Promise<void>;
  updateActivity(snapshot: AgentRunSnapshot): Promise<void>;
  /** Optional live-state path for channels that coalesce streaming text before delivery. */
  updateActivitySource?(update: AgentActivityUpdate): Promise<void>;
  sendFinalReply(text: string): Promise<void>;
  sendImages?(images: readonly GeneratedImage[]): Promise<readonly DeliveredImage[] | void>;
  sendVideos?(videos: readonly GeneratedVideo[]): Promise<void>;
  sendOutput?(output: ConversationOutput): Promise<void>;
  sendFailure(text: string): Promise<void>;
}
