export type PermissionCategory =
  "read" | "write" | "execute" | "sensitive-read" | "high-risk-execute";

export interface PermissionRequest {
  category: PermissionCategory;
  target: string;
  description?: string;
  risk?: string;
}

export interface PermissionDecision {
  allowed: boolean;
  remember: boolean;
}

export interface PermissionChecker {
  check(request: PermissionRequest): Promise<boolean>;
}
