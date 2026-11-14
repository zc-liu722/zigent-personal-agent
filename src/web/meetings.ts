import type { Server } from "node:http";
import { MeetingCoordinator } from "../meetings/coordinator.js";
import { attachLegacyMeetingGateway, type MeetingGatewayOptions } from "../meetings/legacy-media.js";

/** Web entry point retained while new calls migrate to the independent media service. */
export class WebMeetings extends MeetingCoordinator {
  attach(server:Server,options:MeetingGatewayOptions){
    return attachLegacyMeetingGateway(server,{...options,rtc:this.mediaConfiguration()},this);
  }
}
