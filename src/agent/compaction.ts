import type { ModelProvider } from "../providers/provider.js";
import type { SessionService } from "../sessions/session-service.js";
import type { SessionState } from "../sessions/state.js";
import { CancellationError, ProviderError } from "../utils/errors.js";
import type { AgentEventSink } from "./events.js";
import { emptyUsage } from "./messages.js";
import type { AgentMessage, TokenUsage } from "./messages.js";
import type { ContextManager } from "./context-manager.js";

export const COMPACTION_SYSTEM_PROMPT = `Summarize the supplied coding-agent history into durable factual context. Use exactly these headings:

User goal
Repository facts
Files inspected
Files changed
Commands and results
Important decisions
Failed attempts
Remaining work

Preserve command exit status, test failures, uncertainty, permission denials, and unfinished work accurately. Never turn a failed or unexecuted check into a success. Do not include secrets. Return only the structured summary and do not call tools.`;

export interface CompactContextOptions {
  provider: ModelProvider;
  model: string;
  session: SessionState;
  sessions: SessionService;
  context: ContextManager;
  signal?: AbortSignal;
  force?: boolean;
  emit?: AgentEventSink;
}

export interface CompactionResult {
  summary: string;
  compactedMessageCount: number;
  usage: TokenUsage;
}

export async function compactContext(
  options: CompactContextOptions,
): Promise<CompactionResult | undefined> {
  const selection = options.context.selectForCompaction(options.session, {
    force: options.force,
  });
  if (selection === undefined) {
    return undefined;
  }

  const prompt = formatCompactionInput(
    selection.previousSummary,
    selection.messages,
  );
  const requestMessage: AgentMessage = {
    role: "user",
    content: prompt,
    timestamp: Date.now(),
  };
  let summary = "";
  let sawDone = false;
  const usage = emptyUsage();

  try {
    for await (const event of options.provider.stream(
      {
        model: options.model,
        systemPrompt: COMPACTION_SYSTEM_PROMPT,
        messages: [requestMessage],
        tools: [],
        sessionId: options.session.id,
      },
      { signal: options.signal },
    )) {
      switch (event.type) {
        case "text_delta":
          summary += event.text;
          break;
        case "reasoning_delta":
        case "provider_item":
          break;
        case "usage":
          usage.inputTokens += event.inputTokens ?? 0;
          usage.outputTokens += event.outputTokens ?? 0;
          usage.cachedInputTokens += event.cachedInputTokens ?? 0;
          break;
        case "done":
          sawDone = true;
          break;
        case "tool_call_start":
        case "tool_call_delta":
        case "tool_call_end":
          throw new ProviderError(
            "Model attempted a tool call during context compaction",
          );
      }
    }
  } catch (error) {
    if (options.signal?.aborted) {
      throw new CancellationError("Context compaction was cancelled", {
        cause: error,
      });
    }
    throw error;
  }

  if (!sawDone) {
    throw new ProviderError(
      "Context compaction stream ended without a final event",
    );
  }
  summary = summary.trim();
  if (summary === "") {
    throw new ProviderError("Context compaction returned an empty summary");
  }

  await options.sessions.compact(
    options.session.id,
    summary,
    selection.compactedMessageCount,
  );
  if (
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.cachedInputTokens > 0
  ) {
    await options.sessions.addUsage(options.session.id, usage);
    options.emit?.({ type: "usage", usage });
  }

  return {
    summary,
    compactedMessageCount: selection.compactedMessageCount,
    usage,
  };
}

function formatCompactionInput(
  previousSummary: string | undefined,
  messages: readonly AgentMessage[],
): string {
  const sections: string[] = [];
  if (previousSummary !== undefined) {
    sections.push(`Previous summary:\n${previousSummary}`);
  }
  sections.push(
    `History to incorporate:\n${JSON.stringify(messages, null, 2)}`,
  );
  return sections.join("\n\n");
}
