/** Business-facing media boundary. Audio bytes and render queues belong to adapters. */
export type MeetingMediaVersion = {
  connection: number;
  utterance: number;
  output: number;
};

export type MeetingMediaCommand = MeetingMediaVersion & { id: string };
export type MeetingPlaybackEvidence={kind:'created'|'generated'|'sent'|'started'|'ended'|'interrupted';generation:number;itemId?:string;responseId?:string;trackSid?:string;samples?:number;evidence?:'render_observed'|'estimated';metrics?:Record<string,number>};
export type MeetingConsultation = { call_id: string; name: string; arguments: string };

export interface MeetingMedia {
  readonly generation: number;
  readonly outputDone: boolean;
  readonly userVersion?: number;
  ready(opening: string): void;
  update(instructions: string, command?: MeetingMediaCommand): void;
  toolResults(requests: MeetingConsultation[], result: object): void;
  mute(muted: boolean): void;
  clear(): void;
  /** Completion is supplier cancellation acknowledgement, never a timeout guess. */
  interrupt(then: () => void, command?: MeetingMediaCommand): void;
  speak(text: string): void;
  close(state: 'paused' | 'ended', message?: string): void;
  report(phase: string): void;
}

export type MeetingMediaOptions = {
  agent: string;
  apiKey: string;
  connection: number;
  initialGeneration: number;
  providerSessionId?: string;
  instructions: string;
  active: () => boolean;
  current: () => boolean;
  version: () => MeetingMediaVersion;
  event: (event: any) => void;
  heard: () => void;
  evidence?: (event:MeetingPlaybackEvidence)=>void;
  /** Client render evidence; not supplier completion or a server queue drain. */
  drained: (generation: number) => void;
  recover: (reason: string) => void;
  pause: (reason: string) => void;
  finish: (reason: string, resumable?: boolean) => void;
  audioPaused: () => void;
};

export type MeetingMediaFactory = (options: MeetingMediaOptions) => MeetingMedia;

export function sameMediaVersion(a: MeetingMediaVersion, b: MeetingMediaVersion): boolean {
  return a.connection === b.connection && a.utterance === b.utterance && a.output === b.output;
}
