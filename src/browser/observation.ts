import type { ReferenceImage } from "../image-generation.js";

export type ObservationImage = ReferenceImage & { observationId: string };
export type VisualObservation = { kind: "visual_observation"; id: string; metadata: unknown; images: ObservationImage[] };
export function isVisualObservation(value: unknown): value is VisualObservation {
  return Boolean(value && typeof value === "object" && (value as VisualObservation).kind === "visual_observation"
    && Array.isArray((value as VisualObservation).images));
}
