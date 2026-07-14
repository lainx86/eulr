import type { AgentMessage } from "./messages.js";
import type { SessionState } from "../sessions/state.js";

const DEFAULT_CONTEXT_WINDOW = 100_000;
const DEFAULT_THRESHOLD_RATIO = 0.8;
const DEFAULT_RECENT_MESSAGES = 8;

export interface ContextManagerOptions {
  contextWindow?: number;
  thresholdRatio?: number;
  preserveRecentMessages?: number;
}

export interface CompactionSelection {
  previousSummary?: string;
  messages: AgentMessage[];
  compactedMessageCount: number;
}

export class ContextManager {
  readonly contextWindow: number;
  readonly thresholdTokens: number;
  readonly preserveRecentMessages: number;

  constructor(options: ContextManagerOptions = {}) {
    this.contextWindow = options.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const ratio = options.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO;
    if (!(ratio > 0 && ratio <= 1)) {
      throw new Error("Context threshold ratio must be between 0 and 1");
    }
    this.thresholdTokens = Math.floor(this.contextWindow * ratio);
    this.preserveRecentMessages =
      options.preserveRecentMessages ?? DEFAULT_RECENT_MESSAGES;
  }

  messagesForRequest(state: SessionState): AgentMessage[] {
    return state.messages.slice(state.compactedMessageCount);
  }

  estimateTokens(
    state: SessionState,
    systemPrompt: string,
    projectInstructions?: string,
  ): number {
    const messages = this.messagesForRequest(state);
    let characters = systemPrompt.length + (projectInstructions?.length ?? 0);
    for (const message of messages) {
      characters += JSON.stringify(message).length;
    }
    return Math.ceil(characters / 4) + messages.length * 8;
  }

  shouldCompact(
    state: SessionState,
    systemPrompt: string,
    options: {
      projectInstructions?: string;
      reportedInputTokens?: number;
    } = {},
  ): boolean {
    const estimate = this.estimateTokens(
      state,
      systemPrompt,
      options.projectInstructions,
    );
    return (
      Math.max(estimate, options.reportedInputTokens ?? 0) >=
      this.thresholdTokens
    );
  }

  selectForCompaction(
    state: SessionState,
    options: { force?: boolean } = {},
  ): CompactionSelection | undefined {
    const start = state.compactedMessageCount;
    const maximum = options.force
      ? Math.max(start, state.messages.length - 1)
      : Math.max(start, state.messages.length - this.preserveRecentMessages);
    if (maximum <= start) {
      return undefined;
    }

    for (let index = maximum; index > start; index -= 1) {
      if (
        state.messages[index]?.role === "user" &&
        this.isSafeBoundary(state.messages, index)
      ) {
        return {
          previousSummary: state.contextSummary,
          messages: state.messages.slice(start, index),
          compactedMessageCount: index,
        };
      }
    }
    return undefined;
  }

  private isSafeBoundary(
    messages: readonly AgentMessage[],
    index: number,
  ): boolean {
    const calls = new Set<string>();
    const results = new Set<string>();
    for (let position = 0; position < index; position += 1) {
      const message = messages[position];
      if (message?.role === "assistant") {
        for (const content of message.content) {
          if (content.type === "tool_call") {
            calls.add(content.callId);
          }
        }
      } else if (message?.role === "tool") {
        results.add(message.callId);
      }
    }
    for (const callId of calls) {
      if (!results.has(callId)) {
        return false;
      }
    }
    for (const callId of results) {
      if (!calls.has(callId)) {
        return false;
      }
    }
    return true;
  }
}
