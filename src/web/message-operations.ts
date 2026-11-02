import type { AgentActivityOperation } from "../agent/transcript.js";
import type { WebMessage } from "./store.js";

/** Non-transcript deliveries share the same ordered message revision. */
export type WebMessageOperation = AgentActivityOperation | {
  type: "update_message";
  fields: Pick<Partial<WebMessage>, "text" | "assets" | "interactions" | "replyDurationMs">;
};
