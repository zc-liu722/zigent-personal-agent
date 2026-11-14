import type { PluginInstance } from '../contracts.js';
import type { RecordingCapability, RecordingConnection } from '../../capabilities/recordings.js';
import { recordingWorkflow } from './workflow.js';
import { WebAudioTranscriptions } from './transcriptions.js';

export async function create(resources: Readonly<Record<string, unknown>>): Promise<PluginInstance> {
  const connection = resources.recordingConnection as RecordingConnection;
  let transcriptions: WebAudioTranscriptions | undefined;
  let calls = 0;
  const connect = () => { if(connection.store)transcriptions ??= new WebAudioTranscriptions(connection.store,connection.config,connection.objects); };
  const capability: RecordingCapability = { ...recordingWorkflow, connect,
    async transcribe(id, signal, progress) {
      if (!connection.store) throw new Error('录音附件服务尚未就绪，请重试。');
      // Lazy active use: preparing a candidate never starts cleanup or writes data.
      connect();
      calls++;
      try { return await transcriptions!.transcribe(id, signal, progress); }
      finally { calls--; }
    }
  };
  return { services: { recordingWorkflow: capability }, async ready() {}, start:connect, activeWork: () => calls,
    async dispose() { transcriptions?.close(); } };
}
