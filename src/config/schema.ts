import { z } from "zod";

export const providerConfigSchema = z.object({
  defaultModel: z.string().min(1).optional(),
  defaultReasoningEffort: z.string().min(1).optional(),
  baseUrl: z.url().optional(),
});

export const eulrConfigSchema = z.object({
  defaultProvider: z.string().min(1).optional(),
  providers: z.record(z.string(), providerConfigSchema).default({}),
});

export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type EulrConfig = z.infer<typeof eulrConfigSchema>;

export const defaultConfig = (): EulrConfig => ({ providers: {} });
