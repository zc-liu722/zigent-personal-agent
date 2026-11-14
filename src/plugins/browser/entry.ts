import type { PluginInstance } from '../contracts.js';
import type { BrowserService } from '../../browser/service.js';
import { createBrowserTool } from './tool.js';
export async function create(resources: Readonly<Record<string,unknown>>): Promise<PluginInstance> {
  const tool=createBrowserTool(resources.browser as BrowserService | undefined);
  return {tools:[tool],async ready(){},async dispose(){}};
}
