const SECRET_KEY_PATTERN =
  /^(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|authorization[_-]?code|code[_-]?verifier)$/i;
const REDACTED = "[REDACTED]";

export function redactText(input: string): string {
  return (
    input
      // Strip terminal control bytes before writing untrusted errors to a terminal.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
      .replace(
        /(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;"']+/gi,
        `$1${REDACTED}`,
      )
      .replace(/(bearer\s+)[a-z0-9._~+/=-]+/gi, `$1${REDACTED}`)
      .replace(
        /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|authorization[_-]?code|code[_-]?verifier)\s*["']?\s*[:=]\s*["']?)[^\s,"';&}]+/gi,
        `$1${REDACTED}`,
      )
      .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, REDACTED)
  );
}

export function redactValue(value: unknown): unknown {
  return redactValueInternal(value, new WeakSet<object>());
}

function redactValueInternal(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValueInternal(item, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SECRET_KEY_PATTERN.test(key)
      ? REDACTED
      : redactValueInternal(item, seen);
  }
  return result;
}

export function sanitizeError(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(redactText(String(error)));
  }
  const sanitized = new Error(redactText(error.message));
  sanitized.name = error.name;
  if (error.stack !== undefined) {
    sanitized.stack = redactText(error.stack);
  }
  return sanitized;
}

export { REDACTED };
