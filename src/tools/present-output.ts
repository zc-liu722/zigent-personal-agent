import { conversationOutputInputSchema, outputContinuationInstruction, presentOutputSchema } from "../channels/output.js";
import type { AgentToolRegistration } from "./registry.js";

export function createPresentOutputTool(): AgentToolRegistration {
  return {
    executionMode: "sequential",
    definition: { type: "function", name: "present_output",
      description: "Present visual results inline; ordinary short replies and tables use reply Markdown. Choose chart for fixed data, interactive for adjustable figures, animation for moving scenes; exported video uses video_generation. Give independent figures separate blocks and exact visible-text after anchors. Reuse id to update. Up to three interactive/animation blocks per output. HTML is isolated local exploration, without network, libraries or real actions; documents are .md artifacts, not memory/server writes. Continue without repeating delivered prose.",
      input_schema: conversationOutputInputSchema },
    activity: {
      started: () => ({ title: "展示可视化", message: "我正在整理可视化成果。" }),
      completed: () => ({ title: "展示可视化", message: "可视化成果已展示。" }),
      failed: () => ({ title: "展示可视化", message: "这次成果未能展示，我会继续用文字说明。" })
    },
    execute: async (input, context) => {
      context.signal?.throwIfAborted();
      if (!context.presentOutput) throw new Error("Visual output is unavailable in this conversation");
      const parsed = presentOutputSchema.safeParse(input);
      if (!parsed.success) throw new Error(`Invalid visual output: ${parsed.error.issues.slice(0, 3)
        .map(issue => `${issue.path.join(".") || "output"}: ${issue.message}`).join("; ")}`);
      await context.presentOutput(parsed.data);
      context.signal?.throwIfAborted();
      return { status: "presented", blockCount: parsed.data.blocks.length, continuation: outputContinuationInstruction,
        ...(parsed.data.blocks.some(block => block.type === "document") ? {
          memoryChanged: false,
          message: "Documents were displayed as conversation artifacts. No personal memory was changed. Use long_term_memory for personal memory and its confirmation component before claiming a save."
        } : {}) };
    }
  };
}
