import { join } from "node:path";

export type PersonalIntegrationConfig = {
  agentId: string;
  ownerUserId?: string;
  proxyUrl?: string;
  authorization?: { bridgeUrl: string; bridgeSecret: string; timeoutMs: number };
};
export type GoogleOAuthConfig = PersonalIntegrationConfig & {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  tokenPath: string;
};
export type GoogleCalendarConfig = GoogleOAuthConfig;
export type GoogleDriveConfig = GoogleOAuthConfig;
export type TodoistConfig = PersonalIntegrationConfig & { apiToken?: string; tokenPath?: string; clientId?: string; clientSecret?: string };
export type ProductivityIntegration = "google_calendar" | "google_drive" | "todoist";
export type TodoistConnection = { network?: "direct" | "proxy" };

/** Never borrow another Agent's account or infer its owner from a recent conversation. */
export function loadProductivityConfig(agentId: string, prefix: string, environment: NodeJS.ProcessEnv, storageDirectory: string, proxyUrl?: string, authorization?: PersonalIntegrationConfig["authorization"], todoistConnection?: TodoistConnection) {
  const read = (key: string) => environment[key]?.trim() || undefined;
  const verifiedOwner = read(`${prefix}_WEB_OWNER_USER_ID`) ?? read(`${prefix}_NOTIFICATION_OWNER_USER_ID`);
  const driveClientPrefix = [`${prefix}_GOOGLE_DRIVE`, "GOOGLE_DRIVE", `${prefix}_GOOGLE_CALENDAR`, "GOOGLE_CALENDAR"]
    .find(candidate => read(`${candidate}_CLIENT_ID`) || read(`${candidate}_CLIENT_SECRET`));
  const calendarClientPrefix = [`${prefix}_GOOGLE_CALENDAR`, "GOOGLE_CALENDAR"]
    .find(candidate => read(`${candidate}_CLIENT_ID`) || read(`${candidate}_CLIENT_SECRET`));
  return {
    google_drive: {
      agentId, proxyUrl, authorization, tokenPath: join(storageDirectory, "google-drive-oauth.json"),
      ownerUserId: read(`${prefix}_GOOGLE_DRIVE_OWNER_USER_ID`) ?? verifiedOwner,
      clientId: driveClientPrefix ? read(`${driveClientPrefix}_CLIENT_ID`) : undefined,
      clientSecret: driveClientPrefix ? read(`${driveClientPrefix}_CLIENT_SECRET`) : undefined,
      refreshToken: read(`${prefix}_GOOGLE_DRIVE_REFRESH_TOKEN`)
    } satisfies GoogleDriveConfig,
    google_calendar: {
      agentId, proxyUrl, authorization, tokenPath: join(storageDirectory, "google-calendar-oauth.json"),
      ownerUserId: read(`${prefix}_GOOGLE_CALENDAR_OWNER_USER_ID`) ?? verifiedOwner,
      clientId: calendarClientPrefix ? read(`${calendarClientPrefix}_CLIENT_ID`) : undefined,
      clientSecret: calendarClientPrefix ? read(`${calendarClientPrefix}_CLIENT_SECRET`) : undefined,
      refreshToken: read(`${prefix}_GOOGLE_CALENDAR_REFRESH_TOKEN`)
    } satisfies GoogleCalendarConfig,
    todoist: {
      agentId, proxyUrl: todoistConnection?.network === "direct" ? undefined : proxyUrl,
      authorization,
      ownerUserId: read(`${prefix}_TODOIST_OWNER_USER_ID`) ?? verifiedOwner,
      apiToken: read(`${prefix}_TODOIST_API_TOKEN`), tokenPath: join(storageDirectory, "todoist-oauth.json"),
      clientId: read(`${prefix}_TODOIST_CLIENT_ID`) ?? read("TODOIST_CLIENT_ID"),
      clientSecret: read(`${prefix}_TODOIST_CLIENT_SECRET`) ?? read("TODOIST_CLIENT_SECRET")
    } satisfies TodoistConfig
  };
}
