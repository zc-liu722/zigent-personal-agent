/** Conversation data is separate from DOM views, composer controls and stream resources. */
export function createConversationState() {
  return {
    messagesLoading: false, hasOlder: false, selectedModel: undefined,
    current: undefined, conversations: [], messages: [], assetDimensions: {}, busy: false,
    historyQuery: '', historyRows: [], historyNextCursor: undefined, historyLoading: false, historyError: '',
    queuedMessages: [], queueVersion: 0, activeMessageId: undefined,
    browserSession: undefined, browserVersion: 0, authenticated: false,
    conversationGreeting: '', homeGreeting: '', branchOrigin: undefined,
    conversationRevision: undefined, selectionVersion: 0, draftId: undefined,
    select(id, greeting = '') {
      this.selectionVersion++; this.browserVersion++; this.queueVersion++;
      this.messagesLoading = false; this.hasOlder = false; this.selectedModel = undefined;
      this.current = id; this.conversationGreeting = greeting;
      this.browserSession = this.branchOrigin = this.conversationRevision = undefined;
      this.draftId = this.activeMessageId = undefined;
      this.messages = []; this.assetDimensions = {}; this.queuedMessages = []; this.busy = false;
    },
    upsertMessage(message) {
      const index = this.messages.findIndex(item => item.id === message.id);
      if (index < 0) { this.messages.push(message); this.messages.sort((a, b) => a.seq - b.seq); }
      else this.messages[index] = message;
    }
  };
}
