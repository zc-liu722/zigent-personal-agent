import type { UserQuestionRequest, UserQuestionResult } from "../channels/user-questions.js";
import type { ConversationOutput } from "../channels/output.js";
import type { GeneratedImage, ImageGenerator, ImageConversationRequest, ReferenceImage } from "../image-generation.js";
import type { VideoGenerator } from "../video-generation.js";
import type { MemoryChangeRequest } from "../memory/changes.js";
import type { ImageGenerationRecord } from "../memory/types.js";
import type { ModelFunctionTool, ModelTool } from "../models/types.js";
import type { ProductivityIntegration } from "../productivity/config.js";
import type { TaskProposal } from "../tasks/types.js";
import type { ToolActivityPresentation, ToolActivityPresentationContext, ToolActivityPresenter } from "./activity-presentation.js";
import type { OperationDraft } from "./operation-policy.js";
import type { ViewedSessionImage } from "./view-session-image.js";

export type AgentToolSet = {
  readonly names: readonly string[];
  readonly localNames: readonly string[];
  readonly definitions: readonly ModelTool[];
  /** Recomputed at every round; project tools are private and require a loaded skill. */
  definitionsFor?(context?: ToolExecutionContext): readonly ModelTool[];
  isAvailable?(name: string, context?: ToolExecutionContext): boolean;
  allows(name: string): boolean;
  isLocal(name: string): boolean;
  presentActivity(
    name: string,
    phase: "started" | "completed" | "failed",
    input: unknown,
    outcome?: unknown,
    context?: ToolActivityPresentationContext
  ): ToolActivityPresentation;
  executionMode?(name: string): "parallel" | "sequential";
  execute(name: string, input: unknown, context: ToolExecutionContext): Promise<unknown>;
};

export type ToolExecutionContext = {
  /** Executor-owned delegation scope; never accepted from model arguments. */
  readonly subagents?: import("./subagents.js").SubagentControl;
  readonly subagent?: boolean;
  /** Channel-owned file access; models only select references, never database paths. */
  readonly documentLibrary?: {
    list(all?: boolean, offset?: number, limit?: number): Array<{ id: string; name: string; mime: string; size: number; sha256: string }>;
    metadata(id: string): { id: string; name: string; mime: string; size: number; sha256: string; movedTo?: { project: string; path: string; sha256: string } };
    read(id: string): Promise<{ id: string; name: string; mime: string; size: number; sha256: string; bytes: Buffer }>;
    importFile(path: string): Promise<{ id: string; name: string; mime: string; size: number; sha256: string }>;
    editText?(id: string, expected: string, bytes: Buffer): { id: string; name: string; mime: string; size: number; sha256: string };
    moveToProject?(id: string, expected: string, destination: { project: string; path: string; sha256: string }): void;
  };
  readonly agentId: string;
  readonly userId: string;
  /** Stable identity shared across Feishu apps, when supplied by the channel. */
  readonly principalId?: string;
  readonly sessionId: string;
  readonly turnId: number;
  /** Verbatim recent user requests captured by the channel, never supplied by model arguments. */
  readonly delegationRequest?: string;
  readonly delegationMemory?: string;
  /** Resolve cited user turns through owner-scoped history, including other private sessions. */
  readonly resolveDelegationSources?: (sources: readonly { sessionId: string; turnId: number }[]) => Promise<string>;
  /** Read only an already executed result in this run; never accepts a session or user selector. */
  readonly readLiveToolOutput?: (input: { toolCallId: string; offset?: number; limit?: number; expectedHash?: string }) => {
    tool_call_id: string; content: string; content_offset: number; content_length: number;
    next_content_offset?: number; sha256: string; failed: boolean; trust: "reference";
  };
  /** Canonical model executing this tool call; captured for this turn. */
  readonly model?: import("../config.js").Provider;
  readonly reasoningEfforts?: Readonly<Record<string, import("../config.js").ReasoningEffort>>;
  /** Trusted scheduler run identity, never model-supplied. */
  readonly taskRunId?: string;
  readonly backgroundTaskKind?: "proactive";
  readonly taskLeaseToken?: string;
  /** Channel-supplied routing; never taken from model arguments. */
  readonly conversationId?: string;
  readonly conversationKind?: "p2p" | "group";
  /** Signals that a newer user message superseded this run. */
  readonly signal?: AbortSignal;
  /** Current run-owned delivery; models cannot select another message or conversation. */
  readonly presentOutput?: (output: ConversationOutput) => Promise<void>;
  /** Current reply identity, assigned by the channel, never model supplied. */
  readonly replyId?: string;
  /** Current run-owned early image delivery; final completion reuses its assets. */
  readonly presentImages?: (images: readonly GeneratedImage[]) => Promise<void>;
  /** Trusted channel form; waits for the original user and resumes this tool call. */
  readonly askUserQuestion?: (request: UserQuestionRequest) => Promise<UserQuestionResult>;
  /** Trusted channel confirmation UI. A proposal never activates a task. */
  readonly proposeTask?: (proposal: TaskProposal) => Promise<{ proposalId: string }>;
  readonly proposeMemory?: (proposal: MemoryChangeRequest) => Promise<{ proposalId: string }>;
  /** Trusted channel UI; offering a draft never executes its write. */
  readonly proposeOperation?: (draft: OperationDraft) => Promise<{ proposalId: string }>;
  /** Trusted owner-only channel delivery for the fixed editable memory documents. */
  readonly openMemory?: () => Promise<{ proposalId: string }>;
  readonly feishuAppId?: string;
  readonly feishuAppSecret?: string;
  readonly imageGenerator?: ImageGenerator;
  readonly imageConversation?: () => Promise<ImageConversationRequest>;
  /** Executor-owned budget claimed only after validation, just before rendering. */
  readonly claimImageGeneration?: () => void;
  readonly videoGenerator?: VideoGenerator;
  readonly referenceImages?: readonly ReferenceImage[];
  /** The generation mode selected by prepare_image_generation for this turn. */
  readonly imageGenerationAction?: "generate" | "edit";
  readonly onImageGenerationRecords?: (records: readonly ImageGenerationRecord[]) => Promise<void>;
  readonly viewSessionImages?: (imageIds: readonly string[]) => Promise<ViewedSessionImage[]>;
  /** Starts independent background OAuth and returns immediately; access is not yet restored. */
  readonly startXmindAuthorization?: () => void;
  readonly startNotionAuthorization?: () => void;
  readonly startProductivityAuthorization?: (integration: ProductivityIntegration) => boolean;
  readonly startFeishuUserAuthorization?: () => void;
  /** Channel-owned OAuth rendezvous; resolves only after credentials are saved and verified. */
  readonly authorizeAccount?: (service: ProductivityIntegration | "notion" | "xmind" | "feishu", signal?: AbortSignal) => Promise<void>;
  readonly getFeishuAccountConnection?: () => Promise<{ appId: string; appSecret: string; accessToken?: string; readDocumentsAsUser?: boolean } | undefined>;
  readonly getFeishuUserAccessToken?: () => Promise<string | undefined>;
  readonly invalidateFeishuUserAuthorization?: () => Promise<void>;
};

export type AgentToolRegistration = {
  /** Immutable code-owned capability gate; mutable skill prose cannot grant it. */
  readonly requiredSkill?: string;
  /** Runtime dependency availability, determined by code rather than skill prose. */
  readonly available?: boolean;
  readonly definition: ModelFunctionTool;
  readonly executionMode?: "parallel" | "sequential";
  /** Required user-facing translation for every execution lifecycle phase. */
  readonly activity: ToolActivityPresenter;
  prepare?(input: unknown, context: ToolExecutionContext): Promise<{ input: unknown; context: ToolExecutionContext }>;
  execute(input: unknown, context: ToolExecutionContext): Promise<unknown>;
};
