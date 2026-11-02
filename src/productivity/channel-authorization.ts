import type { AgentToolSettings } from "../config.js";
import type { CommunicationAdapter, InboundMessage } from "../channels/communication.js";
import type { ProductivityIntegration } from "./config.js";
import { ProductivityAuthorizationCoordinator } from "./authorization.js";

export function createProductivityAuthorizationContext(settings: AgentToolSettings | undefined, communication: CommunicationAdapter) {
  const coordinators = new Map((["google_calendar", "google_drive", "todoist"] as const).flatMap(integration => {
    const config = settings?.[integration];
    if (!config) return [];
    const coordinator = new ProductivityAuthorizationCoordinator(integration, config);
    return coordinator.available ? [[integration, { coordinator, config }] as const] : [];
  }));
  return <T extends Pick<InboundMessage, "userId" | "conversationId" | "conversationKind">>(message: T) => ({
    startProductivityAuthorization: (integration: ProductivityIntegration): boolean => {
      const entry = coordinators.get(integration);
      if (!entry || !communication.sendProductivityAuthorization || !communication.sendProductivityAuthorizationResult
        || message.conversationKind !== "p2p" || message.userId !== entry.config.ownerUserId) return false;
      entry.coordinator.start(prompt => communication.sendProductivityAuthorization!({ conversationId: message.conversationId, ...prompt }), (outcome, failure) =>
        failure ? communication.sendProductivityAuthorizationResult!(message.conversationId, integration, outcome === "authorized", failure)
          : communication.sendProductivityAuthorizationResult!(message.conversationId, integration, outcome === "authorized"));
      return true;
    }
  });
}
