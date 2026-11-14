import type { PluginInstance } from '../contracts.js';
import type { DocumentCapability } from '../../capabilities/documents/service.js';
import type { isConfirmedOperation } from '../../tools/confirmed-operation.js';
import { DocumentQueries } from './service.js';
import { createDocumentsTool } from './tool.js';
export async function create(resources: Readonly<Record<string,unknown>>): Promise<PluginInstance> {
  const state=resources.documents as DocumentCapability | undefined;
  const capability=state?new DocumentQueries(state):undefined;
  const tool=createDocumentsTool(capability,resources.confirmedOperation as typeof isConfirmedOperation,state?.activity);
  return {tools:[tool],services:{documentQuery:{available:Boolean(capability),capability}},async ready(){},async dispose(){}};
}
