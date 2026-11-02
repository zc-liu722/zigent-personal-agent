import { randomInt } from "node:crypto";

// Server time in Beijing (UTC+8), independent of the host and browser timezones.
const BEIJING_OFFSET = 8 * 60 * 60_000;
export const GREETING_PERIODS = [
  { id: "night", startHour: 0, greetings: [
    "夜深了，有什么想聊的？", "夜里安静，慢慢说。", "还没睡，聊聊心里的事？", "深夜的想法，也可以聊聊。",
    "夜深了，我在听。", "给今晚的思绪找个落点。", "睡前，有什么想说的？", "夜色正静，想聊些什么？"
  ] },
  { id: "morning", startHour: 5, greetings: [
    "早上好，今天想从哪开始？", "新的一天，先聊点什么？", "早安，有什么新想法？", "早上好，一起理理思路？",
    "晨光正好，想聊些什么？", "早安，今天有什么打算？", "新的一天，有什么想做的？", "早上好，慢慢开始。"
  ] },
  { id: "forenoon", startHour: 9, greetings: [
    "上午好，想一起做点什么？", "上午好，有什么想聊的？", "这个上午，从哪个想法开始？", "上午好，一起理理思路。",
    "忙到这里，聊聊新想法？", "上午好，有什么需要帮忙？", "让上午的想法往前走一步。", "上午好，今天进展如何？"
  ] },
  { id: "noon", startHour: 11, greetings: [
    "中午好，歇一会儿聊聊？", "午间片刻，想聊些什么？", "中午好，有什么新想法？", "给午间留一点聊天的时间。",
    "中午好，上午过得怎么样？", "忙了半天，来聊点什么？", "午间稍歇，一起理理思路？", "中午好，接下来想做什么？"
  ] },
  { id: "afternoon", startHour: 14, greetings: [
    "下午好，想聊些什么？", "下午好，一起推进点什么？", "这个下午，有什么新想法？", "下午好，来理理思路？",
    "忙里偷闲，聊一会儿？", "下午好，有什么需要帮忙？", "给下午的想法一点空间。", "下午好，从哪件事开始？"
  ] },
  { id: "evening", startHour: 18, greetings: [
    "晚上好，今天过得怎么样？", "晚上好，想聊些什么？", "忙了一天，来聊一会儿？", "夜色渐深，有什么新想法？",
    "晚上好，一起理理思绪？", "给今晚留一点聊天的时间。", "晚上好，有什么想分享的？", "今晚，想从哪个话题开始？"
  ] }
] as const;

export function greetingPeriod(now = Date.now()): typeof GREETING_PERIODS[number] {
  const hour = new Date(now + BEIJING_OFFSET).getUTCHours();
  return [...GREETING_PERIODS].reverse().find(period => hour >= period.startHour)!;
}

export function selectGreeting(now = Date.now(), pick: (max: number) => number = randomInt): string {
  const { greetings } = greetingPeriod(now);
  return greetings[pick(greetings.length)]!;
}
