import { describe, expect, it, vi } from "vitest";

import { TerminalRenderer } from "../../src/cli/renderer.js";

describe("TerminalRenderer", () => {
  it("shows thinking once per task", () => {
    const output = fakeStream();
    const renderer = new TerminalRenderer(output.stream, output.stream);
    const emit = renderer.eventSink();

    emit({ type: "task_started" });
    emit({ type: "thinking" });
    emit({ type: "thinking" });
    emit({ type: "task_started" });
    emit({ type: "thinking" });

    expect(output.text().match(/Thinking/g)).toHaveLength(2);
  });

  it("redacts tool targets and summaries", () => {
    const output = fakeStream();
    const renderer = new TerminalRenderer(output.stream);
    const render = renderer.eventSink();

    render({
      type: "tool_started",
      callId: "call-1",
      toolName: "bash",
      target: "curl -H 'Authorization: Bearer secret-token' example.test",
      input: { command: "example" },
    });
    render({
      type: "tool_finished",
      callId: "call-1",
      toolName: "bash",
      isError: false,
      summary: "Command used api_key=secret-api-key",
      content: "done",
    });

    const rendered = output.text();
    expect(rendered).not.toContain("secret-token");
    expect(rendered).not.toContain("secret-api-key");
    expect(rendered).toContain("Authorization: [REDACTED]");
    expect(rendered).toContain("api_key=[REDACTED]");
  });

  it("redacts tool output when debug rendering is enabled", () => {
    const output = fakeStream();
    const renderer = new TerminalRenderer(output.stream, output.stream, true);

    renderer.eventSink()({
      type: "tool_output",
      callId: "call-1",
      toolName: "bash",
      stream: "stdout",
      chunk: "access_token=secret-access-token\n",
    });

    const rendered = output.text();
    expect(rendered).not.toContain("secret-access-token");
    expect(rendered).toContain("access_token=[REDACTED]");
  });
});

function fakeStream(): {
  stream: NodeJS.WriteStream;
  text: () => string;
} {
  const chunks: string[] = [];
  const stream = {
    isTTY: false,
    write: vi.fn((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }),
  } as unknown as NodeJS.WriteStream;
  return { stream, text: () => chunks.join("") };
}
