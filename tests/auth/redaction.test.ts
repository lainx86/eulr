import { describe, expect, it } from "vitest";

import {
  redactText,
  redactValue,
  sanitizeError,
} from "../../src/auth/redaction.js";

describe("credential redaction", () => {
  it("redacts headers, bearer tokens, API keys, and token fields", () => {
    const input = [
      "Authorization: Bearer access.secret.token",
      "api_key=sk-supersecret123",
      '"refresh_token":"refresh-secret"',
      "code_verifier=pkce-secret&authorization_code=oauth-secret",
      "\u001b[31mterminal-control",
    ].join("\n");
    const result = redactText(input);

    expect(result).not.toContain("access.secret.token");
    expect(result).not.toContain("sk-supersecret123");
    expect(result).not.toContain("refresh-secret");
    expect(result).not.toContain("pkce-secret");
    expect(result).not.toContain("oauth-secret");
    expect(result).not.toContain("\u001b");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts nested credential objects without changing the input", () => {
    const input = {
      accessToken: "access-secret",
      nested: { authorization: "Bearer hidden", safe: "visible" },
    };
    expect(redactValue(input)).toEqual({
      accessToken: "[REDACTED]",
      nested: { authorization: "[REDACTED]", safe: "visible" },
    });
    expect(input.accessToken).toBe("access-secret");
  });

  it("sanitizes error messages and stacks", () => {
    const result = sanitizeError(new Error("Bearer secret.token.value"));
    expect(result.message).not.toContain("secret.token.value");
    expect(result.stack).not.toContain("secret.token.value");
  });
});
