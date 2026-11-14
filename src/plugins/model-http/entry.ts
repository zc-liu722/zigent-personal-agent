import type { PluginInstance } from '../contracts.js';
import { buildProtocolRequest } from './protocol.js';
export type ModelProtocolService = { buildProtocolRequest: typeof buildProtocolRequest };
export async function create(): Promise<PluginInstance> {
  return {pinForTurn:true,services:{modelProtocol:{buildProtocolRequest} satisfies ModelProtocolService},async ready(){},async dispose(){}};
}
