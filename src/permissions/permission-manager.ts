import path from "node:path";

import type {
  PermissionCategory,
  PermissionChecker,
  PermissionDecision,
  PermissionRequest,
} from "./types.js";

export type PermissionPrompt = (
  request: PermissionRequest,
) => Promise<PermissionDecision>;

export interface PermissionManagerOptions {
  yes?: boolean;
  prompt?: PermissionPrompt;
}

const ALWAYS_AUTOMATIC = new Set<PermissionCategory>(["read"]);
const YES_CATEGORIES = new Set<PermissionCategory>(["write", "execute"]);

export function isSensitivePath(filePath: string): boolean {
  const segments = filePath
    .split(/[\\/]+/u)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());

  return segments.some((segment) => {
    return (
      segment === ".env" ||
      segment.startsWith(".env.") ||
      segment.endsWith(".pem") ||
      segment.endsWith(".key") ||
      segment === "id_rsa" ||
      segment === "id_ed25519" ||
      segment === "credentials.json" ||
      segment === "auth.json"
    );
  });
}

export class PermissionManager implements PermissionChecker {
  readonly #yes: boolean;
  readonly #prompt?: PermissionPrompt;
  readonly #sessionApprovals = new Set<PermissionCategory>();

  constructor(options: PermissionManagerOptions = {}) {
    this.#yes = options.yes ?? false;
    this.#prompt = options.prompt;
  }

  async check(request: PermissionRequest): Promise<boolean> {
    if (ALWAYS_AUTOMATIC.has(request.category)) {
      return true;
    }

    if (this.#sessionApprovals.has(request.category)) {
      return true;
    }

    if (this.#yes && YES_CATEGORIES.has(request.category)) {
      return true;
    }

    if (this.#prompt === undefined) {
      return false;
    }

    const decision = await this.#prompt(request);
    if (
      decision.allowed &&
      decision.remember &&
      request.category !== "high-risk-execute"
    ) {
      this.#sessionApprovals.add(request.category);
    }
    return decision.allowed;
  }

  clearSessionApprovals(): void {
    this.#sessionApprovals.clear();
  }
}

export function permissionTargetPath(value: string): string {
  const normalized = path.normalize(value);
  return normalized === "." ? value : normalized;
}
