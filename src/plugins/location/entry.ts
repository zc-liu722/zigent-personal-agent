import type { PluginInstance } from '../contracts.js';
import type { UserLocationAccess } from '../../location/service.js';
import { LocationCapability } from './capability.js';
import { createUserLocationTool } from './tool.js';
export async function create(resources: Readonly<Record<string,unknown>>): Promise<PluginInstance> {
  const location=resources.location as UserLocationAccess | undefined;
  const capability=location?new LocationCapability(location.store,location.config,location.reverseGeocoder):undefined;
  return {tools:capability?[createUserLocationTool(capability)]:[],services:{locationQuery:{available:Boolean(capability),capability}},async ready(){},async dispose(){}};
}
