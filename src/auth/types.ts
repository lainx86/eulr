export interface ChatGPTCredential {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
  accountId?: string;
  workspaceId?: string;
  email?: string;
  planType?: string;
  isFedRamp?: boolean;
  lastRefreshAt?: number;
}

export interface ApiCredential {
  apiKey: string;
  baseUrl?: string;
}

export type StoredCredential =
  | ({ type: "chatgpt" } & ChatGPTCredential)
  | ({ type: "api-key" } & ApiCredential);

export interface AuthenticationStatus {
  providerId: string;
  authenticated: boolean;
  method?: "chatgpt" | "api-key";
  expiresAt?: number;
  accountId?: string;
  email?: string;
  planType?: string;
  baseUrl?: string;
}

export type FetchImplementation = typeof fetch;
