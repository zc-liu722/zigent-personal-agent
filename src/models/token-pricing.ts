import type { ModelDeployment } from "../config.js";
import { toUsd } from "./currency.js";
export { USD_REFERENCE as TOKEN_PRICE_USD_REFERENCE } from "./currency.js";

export type PriceTier = { input: number; output: number; aboveTokens?: number; cachedInput?: number; cacheWrite5m?: number; cacheWrite1h?: number };
type TokenPrice = {
  currency: "USD" | "CNY"; tiers: readonly PriceTier[]; sourceUrl: string;
  note?: string;
  promotion?: { through: string; regular: PriceTier };
};
export type TokenPriceQuote = { input: string; output: string; unit: string; note: string; checkedAt: string; sourceUrl?: string };
export const TOKEN_PRICES_CHECKED_AT = "2026-10-20";
// Verified against ZenMux's public /api/v1/models pricings and the linked supplier pages.
// Each key is a full routing identity. Never use one supplier's quote for another route.
export const tokenPrices: Readonly<Record<string, TokenPrice>> = {
  "gemini-4argon-zenmux": {
    "currency": "USD",
    "tiers": [
      {
        "input": 2,
        "output": 10,
        "cachedInput": 0.1
      }
    ],
    "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing",
    "promotion": {
      "through": "2026-11-30",
      "regular": {
        "input": 4,
        "output": 20,
        "cachedInput": 0.2
      }
    }
  },
  "claude-haiku-5.5-zenmux": {
    "currency": "USD",
    "tiers": [
      {
        "input": 0.1,
        "output": 0.5,
        "cachedInput": 0.01,
        "cacheWrite5m": 0.125,
        "cacheWrite1h": 0.2
      },
      {
        "input": 0.5,
        "output": 2.5,
        "aboveTokens": 100000,
        "cachedInput": 0.05,
        "cacheWrite5m": 0.625,
        "cacheWrite1h": 1
      }
    ],
    "sourceUrl": "https://platform.claude.com/docs/en/models/haiku-5-5/overview"
  },
  "gpt-6.1sol-zenmux": {
    "currency": "USD",
    "tiers": [
      {
        "input": 2,
        "output": 10,
        "cachedInput": 0.1,
        "cacheWrite5m": 2.5
      },
      {
        "input": 4,
        "output": 15,
        "aboveTokens": 272000,
        "cachedInput": 0.2,
        "cacheWrite5m": 5.0
      }
    ],
    "sourceUrl": "https://developers.openai.com/api/docs/pricing"
  },
  "claude-sonnet-5.5-zenmux": {
    "currency": "USD",
    "tiers": [
      {
        "input": 2,
        "output": 10,
        "cachedInput": 0.1,
        "cacheWrite5m": 2.5,
        "cacheWrite1h": 4
      }
    ],
    "sourceUrl": "https://platform.claude.com/docs/en/models/sonnet-5-5/overview"
  },
  "gpt-6luna-zenmux": {
    "currency": "USD",
    "tiers": [
      {
        "input": 0.1,
        "output": 0.5,
        "cachedInput": 0.01,
        "cacheWrite5m": 0.125
      },
      {
        "input": 0.2,
        "output": 0.75,
        "aboveTokens": 272000,
        "cachedInput": 0.02,
        "cacheWrite5m": 0.25
      }
    ],
    "sourceUrl": "https://developers.openai.com/api/docs/pricing"
  },
  "gpt-6sol-zenmux": {
    "currency": "USD",
    "tiers": [
      {
        "input": 2,
        "output": 10,
        "cachedInput": 0.2,
        "cacheWrite5m": 2.5
      },
      {
        "input": 4,
        "output": 15,
        "aboveTokens": 272000,
        "cachedInput": 0.4,
        "cacheWrite5m": 5.0
      }
    ],
    "sourceUrl": "https://developers.openai.com/api/docs/pricing"
  },
  "claude-opus-5.5-zenmux": {
    "currency": "USD",
    "tiers": [
      {
        "input": 4,
        "output": 20,
        "cachedInput": 0.2,
        "cacheWrite5m": 5,
        "cacheWrite1h": 8
      }
    ],
    "sourceUrl": "https://platform.claude.com/docs/en/models/opus-5-5/overview"
  },
  "gpt-6astra-zenmux": {
    "currency": "USD",
    "tiers": [
      {
        "input": 10,
        "output": 50,
        "cachedInput": 1,
        "cacheWrite5m": 12.5
      },
      {
        "input": 20,
        "output": 75,
        "aboveTokens": 272000,
        "cachedInput": 2,
        "cacheWrite5m": 25.0
      }
    ],
    "sourceUrl": "https://developers.openai.com/api/docs/pricing"
  },
  "gemini-3.8flash-zenmux": {
    "currency": "USD",
    "tiers": [
      {
        "input": 0.75,
        "output": 3.75,
        "cachedInput": 0.075
      }
    ],
    "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing",
    "promotion": {
      "through": "2026-12-31",
      "regular": {
        "input": 1.5,
        "output": 7.5,
        "cachedInput": 0.15
      }
    }
  },
  "claude-fable-5.1-zenmux": {
    "currency": "USD",
    "tiers": [
      {
        "input": 10,
        "output": 50,
        "cachedInput": 0.25,
        "cacheWrite5m": 12.5,
        "cacheWrite1h": 20
      }
    ],
    "sourceUrl": "https://platform.claude.com/docs/en/models/fable-5-1/overview"
  },
  "claude-opus-5-zenmux": {
    "currency": "USD",
    "tiers": [
      {
        "input": 5,
        "output": 25,
        "cachedInput": 0.5,
        "cacheWrite5m": 6.25,
        "cacheWrite1h": 10
      }
    ],
    "sourceUrl": "https://platform.claude.com/docs/en/models/opus-5/overview"
  },
  "kimi-k3-official": {
    "currency": "CNY",
    "tiers": [
      {
        "input": 20,
        "output": 100,
        "cachedInput": 2
      }
    ],
    "note": "缓存命中按优惠价格计费；缓存写入另计。",
    "sourceUrl": "https://platform.kimi.com/docs/pricing/chat"
  },
  "deepseek-v4.1flash-official": {
    "currency": "USD",
    "tiers": [
      {
        "input": 0.15,
        "output": 0.6,
        "cachedInput": 0.003
      },
      {
        "input": 0.3,
        "output": 1.2,
        "cachedInput": 0.006
      }
    ],
    "note": "峰谷价：低谷输入 $0.15、输出 $0.6；高峰输入 $0.3、输出 $1.2。高峰为工作日北京时间 09:00–12:00、14:00–18:00，中国法定节假日除外。",
    "sourceUrl": "https://api-docs.deepseek.com/quick_start/pricing/"
  },
  "doubao-seedevolving-official": {
    "currency": "CNY",
    "tiers": [
      {
        "input": 6,
        "output": 30
      }
    ],
    "sourceUrl": "https://docs.volcengine.com/docs/82379/1544106"
  },
  "doubao-seed2.0lite-official": {
    "currency": "CNY",
    "tiers": [
      {
        "input": 0.6,
        "output": 3.6
      },
      {
        "input": 0.9,
        "output": 5.4,
        "aboveTokens": 32000
      },
      {
        "input": 1.8,
        "output": 10.8,
        "aboveTokens": 128000
      }
    ],
    "note": "在线推理常规档；不使用低优或批量推理折扣。",
    "sourceUrl": "https://docs.volcengine.com/docs/82379/1544106"
  }
};

export function modelTokenPrice(model: Pick<ModelDeployment, "name" | "cost">, now = Date.now()): TokenPriceQuote {
  const unit = "/ 百万 token", checkedAt = TOKEN_PRICES_CHECKED_AT;
  if (model.cost.type === "free") return { input: "0", output: "0", unit, checkedAt, note: "按当前供应商免费策略，无额外 token 费用。" };
  if (model.cost.type === "subscription") return { input: "0", output: "0", unit, checkedAt, note: "使用订阅额度，无额外 API token 费用。" };
  const price = tokenPrices[model.name];
  if (!price) return { input: "—", output: "—", unit, checkedAt, note: "价格尚未核实，以供应商账单为准。" };
  const promotionActive = price.promotion && now < Date.parse(`${price.promotion.through}T23:59:59.999+08:00`) + 1;
  const tiers = price.promotion && !promotionActive ? [price.promotion.regular] : price.tiers;
  const multiplier = toUsd(model.cost.multiplier ?? 1, price.currency);
  const amount = (value: number) => String(Number((value * multiplier).toFixed(4)));
  const range = (field: "input" | "output") => [...new Set(tiers.map(tier => amount(tier[field])))].join("/");
  const notes = [price.note];
  for (const tier of tiers) if (tier.aboveTokens) notes.push(`输入超过 ${tier.aboveTokens / 1000}K：输入 ${amount(tier.input)}，输出 ${amount(tier.output)}。`);
  if (promotionActive && price.promotion) notes.push(`优惠至 ${price.promotion.through}；之后输入 ${amount(price.promotion.regular.input)}，输出 ${amount(price.promotion.regular.output)}。`);
  return { input: range("input"), output: range("output"), unit, checkedAt, sourceUrl: price.sourceUrl, note: notes.filter(Boolean).join(" ") };
}
