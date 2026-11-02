import { Solar } from "lunar-typescript";

// Use the Agent's calendar, independent of the Windows/Linux host timezone.
const localTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});

/** Ephemeral metadata for this invocation; never store it as conversation history. */
export function renderTimeContext(now: Date = new Date()): string {
  const parts = Object.fromEntries(localTime.formatToParts(now).map((part) => [part.type, part.value]));
  const solar = Solar.fromYmd(Number(parts.year), Number(parts.month), Number(parts.day));
  const lunar = solar.getLunar();
  const solarTerm = lunar.getJieQi();
  const festivals = [...new Set([
    ...solar.getFestivals(),
    ...lunar.getFestivals(),
    ...(solarTerm === "清明" ? ["清明节"] : [])
  ])];
  return [
    '<time_context trust="system_metadata">',
    `当前时间：${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+08:00（星期${solar.getWeekInChinese()}）`,
    "时区：Asia/Shanghai（北京时间，UTC+08:00）",
    `农历：${lunar.getYearInChinese()}年${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`,
    `今日节日（中国常见节日）：${festivals.join("、") || "无"}`,
    `今日节气：${solarTerm || "无"}`,
    "以上是系统在本次调用时提供的时间，用于理解今天、明天、今晚等相对时间；用户明确指定其他时区时，按其时区换算。节日不代表法定放假或调休安排。仅在与问题相关时使用，无需例行播报。",
    "</time_context>"
  ].join("\n");
}
