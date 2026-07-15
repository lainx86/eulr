import { z } from "zod";

import type { JsonValue } from "../agent/messages.js";

const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
});

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const assistantContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("reasoning"), text: z.string() }),
  z.object({
    type: z.literal("provider_item"),
    providerId: z.string().min(1),
    data: z.record(z.string(), jsonValueSchema),
  }),
  z.object({
    type: z.literal("tool_call"),
    callId: z.string(),
    toolName: z.string(),
    arguments: z.unknown(),
  }),
]);

const agentMessageSchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("user"),
    content: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    role: z.literal("assistant"),
    content: z.array(assistantContentSchema),
    timestamp: z.number(),
  }),
  z.object({
    role: z.literal("tool"),
    callId: z.string(),
    toolName: z.string(),
    content: z.string(),
    isError: z.boolean(),
    timestamp: z.number(),
  }),
]);

const baseEvent = { timestamp: z.number() };

export const sessionEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...baseEvent,
    type: z.literal("session_created"),
    sessionId: z.string(),
    cwd: z.string(),
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().min(1).optional(),
  }),
  z.object({
    ...baseEvent,
    type: z.literal("message_added"),
    message: agentMessageSchema,
  }),
  z.object({
    ...baseEvent,
    type: z.literal("tool_execution_started"),
    callId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
  }),
  z.object({
    ...baseEvent,
    type: z.literal("tool_execution_finished"),
    callId: z.string(),
    toolName: z.string(),
    content: z.string(),
    isError: z.boolean(),
  }),
  z.object({
    ...baseEvent,
    type: z.literal("usage_updated"),
    usage: usageSchema,
  }),
  z.object({
    ...baseEvent,
    type: z.literal("context_compacted"),
    summary: z.string(),
    compactedMessageCount: z.number().int().nonnegative(),
  }),
  z.object({
    ...baseEvent,
    type: z.literal("session_status_changed"),
    status: z.enum(["active", "completed", "failed", "cancelled"]),
  }),
  z.object({
    ...baseEvent,
    type: z.literal("session_model_changed"),
    model: z.string(),
  }),
  z.object({
    ...baseEvent,
    type: z.literal("session_reasoning_effort_changed"),
    reasoningEffort: z.string().min(1).nullable(),
  }),
]);

export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type SessionStatus = Extract<
  SessionEvent,
  { type: "session_status_changed" }
>["status"];

export { agentMessageSchema, usageSchema };
