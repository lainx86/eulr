import { describe, expect, it } from "vitest";

import { normalizeResponsesStream } from "../../src/providers/adapters/responses.js";
import type { ModelEvent } from "../../src/providers/provider.js";
import { CancellationError } from "../../src/utils/errors.js";

async function collect(
  events: AsyncIterable<ModelEvent>,
): Promise<ModelEvent[]> {
  const result: ModelEvent[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}

describe("Responses SSE adapter", () => {
  it("emits encrypted reasoning as JSON-only provider data", async () => {
    const reasoning = {
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "Inspect the file" }],
      content: [{ type: "reasoning_text", text: "private" }],
      encrypted_content: "opaque-ciphertext",
    };
    const source = [
      {
        type: "response.output_item.done",
        output_index: 0,
        item: reasoning,
      },
      {
        type: "response.completed",
        response: { end_turn: true },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(source));
        controller.close();
      },
    });

    await expect(collect(normalizeResponsesStream(stream))).resolves.toEqual([
      {
        type: "provider_item",
        providerId: "openai-codex",
        data: reasoning,
        outputIndex: 0,
      },
      { type: "done", finishReason: "stop" },
    ]);
  });

  it("handles frame and UTF-8 characters split across byte chunks", async () => {
    const source = [
      `event: response.output_text.delta\r\ndata: ${JSON.stringify({
        type: "response.output_text.delta",
        delta: "A😀B",
      })}\r\n\r\n`,
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: { end_turn: true },
      })}\n\n`,
    ].join("");
    const bytes = new TextEncoder().encode(source);
    const emoji = new TextEncoder().encode("😀");
    const emojiStart = findSubarray(bytes, emoji);
    const cuts = [3, emojiStart + 1, emojiStart + 3, bytes.length - 1];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let previous = 0;
        for (const cut of cuts) {
          controller.enqueue(bytes.slice(previous, cut));
          previous = cut;
        }
        controller.enqueue(bytes.slice(previous));
        controller.close();
      },
    });

    await expect(collect(normalizeResponsesStream(stream))).resolves.toEqual([
      { type: "text_delta", text: "A😀B" },
      { type: "done", finishReason: "stop" },
    ]);
  });

  it("cancels an open stream through AbortSignal", async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({
              type: "response.output_text.delta",
              delta: "partial",
            })}\n\n`,
          ),
        );
      },
    });
    const iterator = normalizeResponsesStream(stream, controller.signal)[
      Symbol.asyncIterator
    ]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "text_delta", text: "partial" },
    });
    controller.abort();
    await expect(iterator.next()).rejects.toBeInstanceOf(CancellationError);
  });
});

function findSubarray(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (
    let index = 0;
    index <= haystack.length - needle.length;
    index += 1
  ) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) {
        continue outer;
      }
    }
    return index;
  }
  throw new Error("Expected byte sequence was not found");
}
