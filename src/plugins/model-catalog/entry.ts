import variants from "#model-assets";
import type { ModelCatalogBinding, ModelCatalogSnapshot } from "../../models/catalog.js";
import type { PluginInstance } from "../contracts.js";

/** Freeze a private copy so a borrower cannot alter another turn's route data. */
function freezeSnapshot<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) freezeSnapshot(entry);
    Object.freeze(value);
  }
  return value;
}

export async function create(resources: Readonly<Record<string, unknown>>): Promise<PluginInstance> {
  const binding = resources.modelCatalogBinding as ModelCatalogBinding | undefined;
  const fallback = resources.bootstrapModelCatalog as ModelCatalogSnapshot;
  const data = binding ? variants[binding.variant] : undefined;
  const catalog = freezeSnapshot(structuredClone(binding && data ? binding.bind(data) : fallback));
  return { pinForTurn: true, services: { modelCatalog: catalog }, async ready() {}, async dispose() {} };
}
