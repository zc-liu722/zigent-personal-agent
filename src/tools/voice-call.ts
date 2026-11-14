import { meetingPlanSchema } from "../meetings/types.js";
import type { AgentToolRegistration } from "./registry.js";
export function createVoiceCallTool(): AgentToolRegistration {
  return { executionMode: "sequential", definition: { type: "function", name: "voice_call", deferExecution: true,
    description: "Send a Zigent voice meeting invitation for focused project/work alignment. Prepare the task context, prioritized questions, sufficient-answer criteria, speech instructions and time limits. Supply invitationText as a short, warm spoken opener addressed to the user, grounded in the known task context, rather than a meeting title. Do not include dates, durations or action buttons in invitationText; the interface adds the actual time and invitation question. Use startsAt=now for an immediate meeting, or an ISO 8601 datetime with an explicit timezone offset for a scheduled meeting. Returns immediately once the invitation is sent. Then finish this reply; do not wait, poll, repeatedly invite, or assume the user has joined. The user joins from the invitation independently; when a started call ends, the main model automatically resumes this original conversation with its previous context and the full meeting transcript to continue the original task. Do not wait or poll for it. Scheduled invitations expand a single Accept action before the start time; accepting syncs the meeting to the user’s Google Calendar. At the start time the orb opens the voice conversation. Immediate invitations open directly from the message or orb. Ending a call preserves its entry, topic and transcript for another round; only expired or cancelled invitations are unavailable. Do not create a separate calendar event; acceptance owns that write. A declined/partial meeting is not consent or a completed decision. The voice host cannot execute project changes; existing confirmation tools still apply. Routine main-model supervision runs only after a completed user utterance of at least 10 letters/digits transitions to audible host speech, at most once per 10 seconds. Explicit host consultations take priority over routine supervision.",
    input_schema: { type: "object", additionalProperties: false, required: ["title","goal","context","instructions","questions","targetSeconds","maxSeconds"], properties: {
      title: {type:"string",maxLength:60}, goal:{type:"string",maxLength:2000}, context:{type:"string",maxLength:16000}, instructions:{type:"string",maxLength:8000},
      invitationText:{type:"string",maxLength:80,description:"A concise conversational opener based only on known context, e.g. 今晚还有几件事没收尾 or 想和你一起过一下明天的安排. No heading, date, duration, agenda or invented user state; the UI adds the invitation question."},
      startsAt:{type:"string",description:"now (default), or a future ISO 8601 datetime with timezone offset, e.g. 2026-11-04T20:00:00+08:00. Use the user's intended date and timezone."},
      targetSeconds:{type:"integer",minimum:30,maximum:1800},maxSeconds:{type:"integer",minimum:30,maximum:3600},
      questions:{type:"array",minItems:1,maxItems:20,items:{type:"object",additionalProperties:false,required:["id","question","required","sufficient"],properties:{id:{type:"string"},question:{type:"string"},required:{type:"boolean"},sufficient:{type:"string"}}}}
    } } },
    activity: { started:()=>({message:"我正在发送会议邀请。",title:"会议邀请",waiting:false}),
      completed:()=>({message:"会议邀请已发送。",waiting:false}),failed:()=>({message:"会议邀请未能发送，请重试。",waiting:false}) },
    execute: async(input,context)=>{
      if (!context.voiceCall || context.subagent || context.taskRunId || context.backgroundTaskKind || context.conversationKind!=="p2p") throw new Error("会议需要本人网页对话。");
      return context.voiceCall(meetingPlanSchema.parse(input),context);
    }
  };
}
