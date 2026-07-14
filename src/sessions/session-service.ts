import { realpath, stat } from "node:fs/promises";

import type { AgentMessage, TokenUsage } from "../agent/messages.js";
import { SessionError } from "../utils/errors.js";
import type { SessionEvent, SessionStatus } from "./events.js";
import { pendingToolCalls, reconstructSession } from "./state.js";
import type { SessionState } from "./state.js";
import { SessionStore } from "./store.js";

const INTERRUPTED_TOOL_RESULT =
  "Tool execution was interrupted before completion and was not rerun.";

export interface CreateSessionOptions {
  cwd: string;
  provider: string;
  model: string;
  id?: string;
}

export class SessionService {
  constructor(
    readonly store: SessionStore,
    private readonly now: () => number = Date.now,
  ) {}

  async create(options: CreateSessionOptions): Promise<SessionState> {
    const cwd = await this.validateWorkingDirectory(options.cwd);
    const id = options.id ?? (await this.uniqueId());
    if (await this.store.exists(id)) {
      throw new SessionError(`Session already exists: ${id}`);
    }
    const event: SessionEvent = {
      type: "session_created",
      timestamp: this.now(),
      sessionId: id,
      cwd,
      provider: options.provider,
      model: options.model,
    };
    await this.store.append(id, event);
    return reconstructSession([event]);
  }

  async load(id: string): Promise<SessionState> {
    const state = await this.store.load(id);
    await this.validateWorkingDirectory(state.cwd);
    return state;
  }

  async resume(id: string): Promise<SessionState> {
    let state = await this.load(id);

    for (const call of pendingToolCalls(state)) {
      const execution = [...state.toolExecutions]
        .reverse()
        .find((candidate) => candidate.callId === call.callId);
      const content = execution?.content ?? INTERRUPTED_TOOL_RESULT;
      const isError = execution?.isError ?? true;

      if (execution !== undefined && execution.finishedAt === undefined) {
        await this.append(id, {
          type: "tool_execution_finished",
          timestamp: this.now(),
          callId: call.callId,
          toolName: call.toolName,
          content,
          isError,
        });
      }
      await this.addMessage(id, {
        role: "tool",
        callId: call.callId,
        toolName: call.toolName,
        content,
        isError,
        timestamp: this.now(),
      });
    }

    await this.setStatus(id, "active");
    state = await this.load(id);
    return state;
  }

  async addMessage(id: string, message: AgentMessage): Promise<void> {
    await this.append(id, {
      type: "message_added",
      timestamp: this.now(),
      message,
    });
  }

  async toolStarted(
    id: string,
    callId: string,
    toolName: string,
    input: unknown,
  ): Promise<void> {
    await this.append(id, {
      type: "tool_execution_started",
      timestamp: this.now(),
      callId,
      toolName,
      input,
    });
  }

  async toolFinished(
    id: string,
    callId: string,
    toolName: string,
    content: string,
    isError: boolean,
  ): Promise<void> {
    await this.append(id, {
      type: "tool_execution_finished",
      timestamp: this.now(),
      callId,
      toolName,
      content,
      isError,
    });
  }

  async addUsage(id: string, usage: TokenUsage): Promise<void> {
    await this.append(id, {
      type: "usage_updated",
      timestamp: this.now(),
      usage,
    });
  }

  async compact(
    id: string,
    summary: string,
    compactedMessageCount: number,
  ): Promise<void> {
    await this.append(id, {
      type: "context_compacted",
      timestamp: this.now(),
      summary,
      compactedMessageCount,
    });
  }

  async setStatus(id: string, status: SessionStatus): Promise<void> {
    await this.append(id, {
      type: "session_status_changed",
      timestamp: this.now(),
      status,
    });
  }

  async setModel(id: string, model: string): Promise<void> {
    await this.append(id, {
      type: "session_model_changed",
      timestamp: this.now(),
      model,
    });
  }

  async list(limit = 20): Promise<SessionState[]> {
    return this.store.list(limit);
  }

  async flush(): Promise<void> {
    await this.store.flush();
  }

  private async append(id: string, event: SessionEvent): Promise<void> {
    await this.store.append(id, event);
  }

  private async validateWorkingDirectory(cwd: string): Promise<string> {
    try {
      const canonical = await realpath(cwd);
      const details = await stat(canonical);
      if (!details.isDirectory()) {
        throw new SessionError(
          `Session working directory is not a directory: ${cwd}`,
        );
      }
      return canonical;
    } catch (error) {
      if (error instanceof SessionError) {
        throw error;
      }
      throw new SessionError(
        `Session working directory is unavailable: ${cwd}`,
        {
          cause: error,
        },
      );
    }
  }

  private async uniqueId(): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = this.store.createId();
      if (!(await this.store.exists(id))) {
        return id;
      }
    }
    throw new SessionError("Unable to allocate a unique session ID");
  }
}
