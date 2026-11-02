import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rename, rm, writeFile } from 'node:fs/promises';
const provider = 'zigent_studio_kimicode';
const documentation = 'https://www.kimi.com/code/docs/third-party-tools/codex.html';
const safeCount = value => Number.isSafeInteger(value) && value > 0;

/** Reuse the existing Kimi Code subscription catalogue and credential flow. No secrets go to the page or catalogue file. */
export async function loadKimiProvider(manifest, directory) {
  const supplier = manifest.catalog.suppliers.kimicode;
  const routes = manifest.catalog.models.filter(route => route.supplier === 'kimicode' && route.protocol === 'openai-responses');
  const envKey = ['COMPONENT_STUDIO_KIMI_CODE_API_KEY', ...(supplier?.apiKeyEnv || []).filter(name => !name.includes('{'))].find(name => process.env[name]?.trim());
  const baseUrl = supplier?.endpoints?.['openai-responses'];
  const unavailable = warning => ({ provider, warning, models: routes.map(route => ({ name: route.name, apiModel: route.apiModel, label: route.name, provider, available: false, reasoningEffort: route.reasoningEffort, reasoning: route.reasoning, cost: { type: 'subscription' }, inputPrice: 0, outputPrice: 0 })) });
  if (!routes.length || !baseUrl) return unavailable('Kimi Code 模型目录未配置');
  if (!envKey) return unavailable('请配置 KIMI_CODE_API_KEY 后重启工作台');
  let response, catalogue;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { headers: { Authorization: `Bearer ${process.env[envKey]}`, 'User-Agent': 'zigent/0.1.0' }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) { await response.body?.cancel(); return unavailable(`Kimi Code 连接失败（HTTP ${response.status}），请检查密钥后重新连接`); }
    catalogue = await response.json();
  } catch { return unavailable('Kimi Code 模型列表读取失败，请重新连接'); }
  const checkedAt = new Date().toISOString().slice(0, 10), native = [];
  const models = routes.map(route => {
    const actual = catalogue.data?.find(model => model.id === route.apiModel);
    const levels = actual?.reasoning?.effort?.valid || actual?.think_efforts?.valid_efforts;
    const window = actual?.limit?.context ?? actual?.context_length ?? route.context?.windowTokens;
    const valid = actual && Array.isArray(levels) && levels.length && levels.every(level => ['low', 'high', 'max'].includes(level)) && safeCount(window);
    const model = { name: route.name, apiModel: route.apiModel, label: actual?.display_name || route.name, provider, available: Boolean(valid),
      reasoningEffort: valid && levels.includes(route.reasoningEffort) ? route.reasoningEffort : actual?.reasoning?.effort?.default || route.reasoningEffort,
      reasoning: valid ? { levels, mode: 'effort', sources: [documentation, `${baseUrl}/models`], checkedAt } : route.reasoning,
      context: valid ? { ...route.context, windowTokens: window, limitSource: 'supplier', sources: [documentation, `${baseUrl}/models`], checkedAt } : route.context,
      cost: { type: 'subscription' }, inputPrice: 0, outputPrice: 0 };
    if (valid) native.push({ slug: route.apiModel, display_name: model.label, description: route.name,
      default_reasoning_level: model.reasoningEffort, supported_reasoning_levels: levels.map(effort => ({ effort, description: effort })),
      shell_type: 'shell_command', apply_patch_tool_type: 'freeform', visibility: 'list', supported_in_api: true, priority: native.length,
      base_instructions: '', supports_reasoning_summaries: true, default_reasoning_summary: 'none', support_verbosity: false,
      truncation_policy: { mode: 'bytes', limit: 10000 }, context_window: window, max_context_window: window,
      effective_context_window_percent: 95, supports_parallel_tool_calls: true, experimental_supported_tools: [], input_modalities: ['text'] });
    return model;
  });
  const contents = JSON.stringify({ models: native });
  const path = join(directory, `kimi-models-${createHash('sha256').update(contents).digest('hex').slice(0, 16)}.json`), temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, contents, { mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
  return { provider, models, warning: models.every(model => model.available) ? '' : '部分 Kimi 模型暂不可用，请检查账户权限后重新连接',
    config: { [`model_providers.${provider}`]: { name: 'Kimi Code', base_url: baseUrl, env_key: envKey, wire_api: 'responses', requires_openai_auth: false }, model_catalog_json: path } };
}
