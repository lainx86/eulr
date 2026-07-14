export const DEFAULT_MAX_OUTPUT_CHARS = 100_000;

export interface LimitedOutput {
  content: string;
  truncated: boolean;
  originalLength: number;
  omittedLength: number;
}

function truncationMarker(omittedLength: number): string {
  return `\n... [truncated ${omittedLength} characters; showing beginning and end] ...\n`;
}

export function limitOutput(
  content: string,
  maxChars = DEFAULT_MAX_OUTPUT_CHARS,
): LimitedOutput {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
    throw new RangeError("maxChars must be a positive safe integer");
  }

  if (content.length <= maxChars) {
    return {
      content,
      truncated: false,
      originalLength: content.length,
      omittedLength: 0,
    };
  }

  const headLength = Math.ceil(maxChars / 2);
  const tailLength = Math.floor(maxChars / 2);
  const omittedLength = content.length - headLength - tailLength;

  return {
    content:
      content.slice(0, headLength) +
      truncationMarker(omittedLength) +
      content.slice(content.length - tailLength),
    truncated: true,
    originalLength: content.length,
    omittedLength,
  };
}

/**
 * Retains bounded output while a process is running. The first and last parts
 * are kept so diagnostics usually include both setup and the final failure.
 */
export class HeadTailOutputBuffer {
  readonly #headLimit: number;
  readonly #tailLimit: number;
  #head = "";
  #tail = "";
  #totalLength = 0;

  constructor(readonly maxChars = DEFAULT_MAX_OUTPUT_CHARS) {
    if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
      throw new RangeError("maxChars must be a positive safe integer");
    }

    this.#headLimit = Math.ceil(maxChars / 2);
    this.#tailLimit = Math.floor(maxChars / 2);
  }

  append(chunk: string): void {
    if (chunk.length === 0) {
      return;
    }

    this.#totalLength += chunk.length;

    if (this.#head.length < this.#headLimit) {
      const needed = this.#headLimit - this.#head.length;
      this.#head += chunk.slice(0, needed);
      chunk = chunk.slice(needed);
    }

    if (chunk.length > 0 && this.#tailLimit > 0) {
      this.#tail = (this.#tail + chunk).slice(-this.#tailLimit);
    }
  }

  result(): LimitedOutput {
    if (this.#totalLength <= this.maxChars) {
      return {
        content: this.#head + this.#tail,
        truncated: false,
        originalLength: this.#totalLength,
        omittedLength: 0,
      };
    }

    const omittedLength =
      this.#totalLength - this.#head.length - this.#tail.length;

    return {
      content: this.#head + truncationMarker(omittedLength) + this.#tail,
      truncated: true,
      originalLength: this.#totalLength,
      omittedLength,
    };
  }
}
