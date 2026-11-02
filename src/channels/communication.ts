import type { CodexEdits } from "../codex/confirmation.js";
import type { Provider } from "../config.js";
import type { ModelFailureKind } from "../llm.js";
import type { StoredImageSource, ReferenceImage } from "../image-generation.js";
import type { Session, SessionMetadata } from "../memory/types.js";
import type { AgentRunChannel } from "./types.js";
import type { ProductivityIntegration } from "../productivity/config.js";
import type { AuthorizationFailure } from "../productivity/authorization-failure.js";
import type { OperationNotice } from "./operation-confirmations.js";
import type { UserQuestionAction, UserQuestionNotice } from "./user-questions.js";
import type { SupplierFailure } from "../models/supplier-health.js";

export type InboundMessage = {
  messageId: string;
  conversationId: string;
  userId: string;
  /** Cross-application identity used only for shared-resource authorization. */
  principalId?: string;
  conversationKind?: "p2p" | "group";
  text: string;
  /** Canonical model identity, validated by the receiving channel. */
  model?: Provider;
  reasoningEfforts?: Readonly<Record<string, import("../config.js").ReasoningEffort>>;
  images?: readonly ReferenceImage[];
  imageOnly?: boolean;
};

export type ModelFallbackNotice = {
  requestId: string;
  conversationId: string;
  failedProvider: Provider;
  fallbackProvider: Provider;
  kind: ModelFailureKind;
  status?: number;
  elapsedMs?: number;
  failedSupplier?: string;
  /** Original failure when the current request was skipped during a circuit window. */
  lastFailure?: SupplierFailure;
  selectableProviders?: Provider[];
};

export type OAuthAuthorizationNotice = {
  conversationId: string;
  authorizationUrl: string;
  expiresAt: number;
};
export type XmindAuthorizationNotice = OAuthAuthorizationNotice;

export interface CommunicationAdapter {
  prepareBackgroundSession?(session: Session): Promise<void>;
  sendUserQuestion?(notice: UserQuestionNotice): Promise<{ messageId: string }>;
  sendOperationConfirmation?(notice: OperationNotice): Promise<{ messageId: string }>;
  /** Independent durable job notices; idempotencyKey must be reused on retry. */
  sendBackgroundResult?(notice: { agentId?: string; userId?: string; conversationKind?: "p2p" | "group"; conversationId: string; idempotencyKey: string; title: string; text: string; replyDurationMs?: number; scheduleReminder?: import("./change-preview.js").CalendarPreviewState; snapshot?: import("../agent/transcript.js").AgentRunSnapshot; session?: Session }): Promise<{ messageId: string }>;
  createRunChannel(conversationId: string): AgentRunChannel;
  sendSessionEnded(session: SessionMetadata, agentName: string, inactivityMinutes: number): Promise<void>;
  sendModelFallback(notice: ModelFallbackNotice): Promise<void>;
  sendStandaloneFailure(conversationId: string, text: string): Promise<void>;
  sendXmindAuthorization?(notice: XmindAuthorizationNotice): Promise<void>;
  sendNotionAuthorization?(notice: OAuthAuthorizationNotice): Promise<void>;
  sendProductivityAuthorization?(notice: OAuthAuthorizationNotice & { service: ProductivityIntegration }): Promise<void>;
  sendProductivityAuthorizationResult?(conversationId: string, service: ProductivityIntegration, authorized: boolean, failure?: AuthorizationFailure): Promise<void>;
  /** Rehydrate a durable chat image reference after the in-memory byte cache expires. */
  readImage?(source: StoredImageSource): Promise<ReferenceImage>;
}

export type InteractionAction =
  | UserQuestionAction
  | { type: "operation-confirmation"; proposalId: string; confirm: boolean; codexEdits?: CodexEdits; codexEditOnly?: boolean }
  | { type: "model-fallback"; requestId: string; confirm: boolean; model?: Provider; retry?: boolean }
  | { type: "resume"; sessionId: string }
  | { type: "delete"; sessionId: string }
  | { type: "feedback"; sessionId: string; rating: "satisfied" | "dissatisfied" };

export type InteractionActionResult = {
  ok: boolean;
  message: string;
};
