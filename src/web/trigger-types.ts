export type TriggerTypeId = "time" | "location" | "external" | "health_change";
export type TriggerType = { id: TriggerTypeId; title: string; available: boolean; canSavePoint: boolean; parameters: string[] };

/** Configurable logic families, separate from persisted points with fixed specifications. */
export function triggerTypes(capabilities: { location: boolean; health: boolean }, deviceAvailable: boolean): TriggerType[] {
  return [
    { id: "time", title: "时间触发器", available: true, canSavePoint: true, parameters: ["周期", "时间", "时区", "补跑期限"] },
    { id: "location", title: "地理触发器", available: capabilities.location, canSavePoint: true, parameters: ["范围", "方向", "速度", "冷却"] },
    { id: "external", title: "设备触发器", available: deviceAvailable, canSavePoint: true, parameters: ["设备", "事件", "冷却"] },
    { id: "health_change", title: "健康触发器", available: capabilities.health, canSavePoint: false, parameters: ["指标", "时段", "合并窗口"] }
  ];
}
