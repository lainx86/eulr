import { z } from "zod";

export const providerConfigSchema = z.object({
  defaultModel: z.string().min(1).optional(),
  defaultReasoningEffort: z.string().min(1).optional(),
  baseUrl: z.url().optional(),
});

export const musicConfigSchema = z.object({
  libraryPath: z.string().min(1).optional(),
  volume: z.number().finite().min(0).max(100).optional(),
  shuffle: z.boolean().optional(),
  repeat: z.boolean().optional(),
  lastTrack: z.string().min(1).optional(),
  positionSeconds: z.number().finite().nonnegative().optional(),
});

export const eulrConfigSchema = z.object({
  defaultProvider: z.string().min(1).optional(),
  providers: z.record(z.string(), providerConfigSchema).default({}),
  music: musicConfigSchema.optional(),
});

export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type MusicConfig = z.infer<typeof musicConfigSchema>;
export type EulrConfig = z.infer<typeof eulrConfigSchema>;

export const defaultConfig = (): EulrConfig => ({ providers: {} });
