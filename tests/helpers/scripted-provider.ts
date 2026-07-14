import type {
  ModelEvent,
  ModelInfo,
  ModelProvider,
  ModelRequest,
  ModelStreamOptions,
} from "../../src/providers/provider.js";

export type ScriptedTurn =
  | readonly ModelEvent[]
  | Error
  | ((
      request: ModelRequest,
      options: ModelStreamOptions,
    ) =>
      | AsyncIterable<ModelEvent>
      | Iterable<ModelEvent>
      | Promise<AsyncIterable<ModelEvent> | Iterable<ModelEvent>>);

export class ScriptedProvider implements ModelProvider {
  readonly id: string;
  readonly requests: ModelRequest[] = [];
  private readonly turns: ScriptedTurn[];

  constructor(turns: Iterable<ScriptedTurn>, id = "fake") {
    this.turns = [...turns];
    this.id = id;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "fake-model", name: "Fake model", contextWindow: 100_000 }];
  }

  async *stream(
    request: ModelRequest,
    options: ModelStreamOptions,
  ): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const turn = this.turns.shift();
    if (turn === undefined) {
      throw new Error("Scripted provider has no response for this request");
    }
    if (turn instanceof Error) {
      throw turn;
    }

    const events =
      typeof turn === "function" ? await turn(request, options) : turn;
    for await (const event of events) {
      if (options.signal?.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      yield event;
    }
  }

  remainingTurns(): number {
    return this.turns.length;
  }
}

export const finalResponse = (text: string): ModelEvent[] => [
  { type: "text_delta", text },
  { type: "done", finishReason: "stop" },
];

export const toolCall = (
  callId: string,
  toolName: string,
  argumentsText: string,
  options: { end?: boolean } = {},
): ModelEvent[] => [
  { type: "tool_call_start", callId, toolName },
  { type: "tool_call_delta", callId, argumentsDelta: argumentsText },
  ...(options.end === false
    ? []
    : ([{ type: "tool_call_end", callId }] satisfies ModelEvent[])),
];
