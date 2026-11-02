import { record, text } from "./normalize.js";

export const NUTRIENTS = ["energy_kcal", "protein_g", "fat_g", "carbohydrates_g", "sugars_g", "fiber_g", "sodium_mg"] as const;
export type Nutrient = typeof NUTRIENTS[number];
export type NutritionEstimate = Partial<Record<Nutrient, number | null>>;
export const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"] as const;
export type MealType = typeof MEAL_TYPES[number];
export type Meal = {
  date: string;
  mealType: MealType;
  photoIds: string[];
  intake: string;
  nutritionEstimate: NutritionEstimate;
};

/** Diary days are explicit Asia/Shanghai calendar dates, not upload timestamps. */
export function diaryDate(value: unknown): string {
  const date = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < "1970-01-01"
    || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
    || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error("INVALID_DIARY_DATE");
  return date;
}

export function diaryRange(fromValue: unknown, toValue: unknown): { from: string; to: string } {
  const from = diaryDate(fromValue), to = diaryDate(toValue);
  if (to < from || Date.parse(to) - Date.parse(from) > 365 * 86400_000) throw new Error("INVALID_DIARY_RANGE");
  return { from, to };
}

export function photoIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 8
    || value.some(id => typeof id !== "string" || !/^health-photo-[a-f0-9]{64}$/.test(id))
    || new Set(value).size !== value.length) throw new Error("INVALID_PHOTO_IDS");
  return [...value];
}

export function nutritionEstimate(value: unknown): NutritionEstimate {
  const input = record(value), result: NutritionEstimate = {};
  for (const [key, amount] of Object.entries(input)) {
    if (!NUTRIENTS.includes(key as Nutrient) || amount !== null
      && (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0)) throw new Error("INVALID_NUTRITION_ESTIMATE");
    result[key as Nutrient] = amount as number | null;
  }
  if (typeof result.sugars_g === "number" && typeof result.carbohydrates_g === "number"
    && result.sugars_g > result.carbohydrates_g) throw new Error("SUGARS_EXCEED_CARBOHYDRATES");
  return result;
}

export function meal(value: unknown): Meal {
  const input = record(value);
  if (!MEAL_TYPES.includes(input.mealType as MealType)) throw new Error("INVALID_MEAL_TYPE");
  return { date: diaryDate(input.date), mealType: input.mealType as MealType,
    photoIds: photoIds(input.photoIds ?? []), intake: text(input.intake, 4000),
    nutritionEstimate: nutritionEstimate(input.nutritionEstimate ?? {}) };
}
