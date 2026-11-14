import { z } from 'zod';
export const version = z.object({ connection:z.number().int().positive(), utterance:z.number().int().nonnegative(), output:z.number().int().nonnegative() }).strict();
const identity=z.string().min(1).max(256);
export const start = z.object({type:z.literal('start'),meetingId:identity,connection:z.number().int().positive(),initialGeneration:z.number().int().nonnegative().default(0),
  livekitUrl:z.string().url().refine(v=>/^wss?:\/\//.test(v)),token:z.string().min(1).max(16384),participant:identity,
  apiKey:z.string().min(1).max(4096),instructions:z.string().max(128000),providerSessionId:identity.optional(),pendingCalls:z.array(identity).max(256).default([])}).strict();
export const command = z.object({id:z.string().uuid(),expected:version,
  action:z.discriminatedUnion('type',[
    z.object({type:z.literal('guide'),instructions:z.string().max(128000)}).strict(),
    z.object({type:z.literal('cancel'),replacement:z.string().max(2000).optional()}).strict(),
    z.object({type:z.literal('opening'),text:z.string().min(1).max(2000)}).strict(),
    z.object({type:z.literal('speak'),text:z.string().min(1).max(2000)}).strict(),
    z.object({type:z.literal('mute'),muted:z.boolean()}).strict(),
    z.object({type:z.literal('diagnostics'),enabled:z.boolean()}).strict(),
    z.object({type:z.literal('attached'),generation:z.number().int().positive(),trackSid:identity}).strict(),
    z.object({type:z.literal('tool_results'),items:z.array(z.object({call_id:identity,result:z.record(z.unknown())}).strict()).min(1).max(32)}).strict(),
    z.object({type:z.literal('playback'),generation:z.number().int().positive(),trackSid:identity,state:z.enum(['started','interrupted','ended','progress']),evidence:z.enum(['render_observed','estimated']),playedSamples:z.number().int().nonnegative().max(1e9).optional()}).strict(),
    z.object({type:z.literal('close')}).strict()
  ])}).strict();
export type Start=z.infer<typeof start>;
export type Version=z.infer<typeof version>;
export type Command=z.infer<typeof command>;
