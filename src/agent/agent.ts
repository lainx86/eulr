import type { SessionService } from "../sessions/session-service.js";
import type { SessionState } from "../sessions/state.js";
import type { AgentLoop, AgentRunResult, RunTaskOptions } from "./loop.js";

export class Agent {
  private sessionState: SessionState;

  constructor(
    private readonly loop: AgentLoop,
    private readonly sessions: SessionService,
    session: SessionState,
  ) {
    this.sessionState = session;
  }

  get session(): SessionState {
    return this.sessionState;
  }

  async run(
    instruction: string,
    options: RunTaskOptions = {},
  ): Promise<AgentRunResult> {
    try {
      const result = await this.loop.runTask(
        this.sessionState,
        instruction,
        options,
      );
      this.sessionState = result.session;
      return result;
    } catch (error) {
      try {
        await this.refresh();
      } catch {
        // The task failure is the actionable error; a refresh failure must not mask it.
      }
      throw error;
    }
  }

  async compact(options: RunTaskOptions = {}): Promise<SessionState> {
    this.sessionState = await this.loop.compactSession(
      this.sessionState,
      options,
    );
    return this.sessionState;
  }

  async refresh(): Promise<SessionState> {
    this.sessionState = await this.sessions.load(this.sessionState.id);
    return this.sessionState;
  }
}
