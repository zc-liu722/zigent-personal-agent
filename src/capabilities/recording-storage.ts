import { TosClient } from '@volcengine/tos-sdk';
import type { WebChannelConfig } from '../config.js';
import type { RecordingObjectStorage } from './recordings.js';

/** Host-owned object storage: SDK native/WASM resources stay with locked dependencies. */
export function recordingObjectStorage(config: NonNullable<WebChannelConfig['transcription']>['tos'] | undefined): RecordingObjectStorage | undefined {
  if(!config)return undefined;
  const client=new TosClient({...config,requestTimeout:10000,connectionTimeout:10000});
  const key=(value:string)=>{
    if(!/^zigent-asr\/[a-f0-9-]{36}\.[a-z0-9]{1,16}$/.test(value))throw new Error('Invalid recording object namespace');
    return value;
  };
  return {
    uploadUrl: value=>client.getPreSignedUrl({bucket:config.bucket,key:key(value),method:'PUT',expires:600}),
    downloadUrl: value=>client.getPreSignedUrl({bucket:config.bucket,key:key(value),method:'GET',expires:6*60*60}),
    async delete(value){await client.deleteObject({bucket:config.bucket,key:key(value)});}
  };
}
