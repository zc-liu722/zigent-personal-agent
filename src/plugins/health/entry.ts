import type { PluginInstance } from '../contracts.js';
import type { UserHealthAccess } from '../../health/service.js';
import type { TaskStore } from '../../tasks/store.js';
import type { UserLocationAccess } from '../../location/service.js';
import { createHealthDataTool } from './data-tool.js';
import { createHealthTasksTool } from './tasks-tool.js';
export async function create(resources: Readonly<Record<string,unknown>>): Promise<PluginInstance> {
  const health=resources.health as UserHealthAccess | undefined, tasks=resources.healthTasks as TaskStore | undefined, location=resources.location as UserLocationAccess | undefined;
  const unavailable=(name:string)=>({requiredSkill:'health',available:false,definition:{type:'function' as const,name,description:'Private health project capability.',input_schema:{type:'object',properties:{}}},
    activity:{started:()=>({message:'我正在查看健康项目。'}),completed:()=>({message:'我已经查看健康项目。'}),failed:()=>({message:'这次未能查看健康项目。'})},execute:async()=>{throw Error('This health capability is not configured');}});
  const tools=health&&tasks?[createHealthDataTool(health),createHealthTasksTool({store:tasks,initialHealthCursor:()=>health.store.highWaterSeq(),
    supportsLocation:()=>Boolean(location?.store.isOwner(health.config.ownerPrincipalId??health.config.ownerUserId,[health.config.ownerUserId]))})]
    :[unavailable('health_data'),unavailable('health_tasks')];
  return {tools,async ready(){},async dispose(){}};
}
