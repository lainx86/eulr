import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

import { defaultConfig, eulrConfigSchema, type EulrConfig } from "./schema.js";
import { ConfigurationError } from "../utils/errors.js";
import type { ReasoningEffort } from "../providers/provider.js";

export class ConfigStore {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  async load(): Promise<EulrConfig> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return defaultConfig();
      throw new ConfigurationError(`Unable to read config: ${this.path}`, {
        cause: error,
      });
    }

    try {
      return eulrConfigSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new ConfigurationError(
        `Invalid config file: ${this.path}. Fix or remove it, then retry.`,
        { cause: error },
      );
    }
  }

  async save(config: EulrConfig): Promise<void> {
    const validated = eulrConfigSchema.parse(config);
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(directory, 0o700);

    const temporary = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      if (process.platform !== "win32") await chmod(temporary, 0o600);
      await rename(temporary, this.path);
      if (process.platform !== "win32") await chmod(this.path, 0o600);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async setDefaultProvider(providerId: string): Promise<void> {
    await this.update((config) => {
      config.defaultProvider = providerId;
    });
  }

  async setDefaultModel(providerId: string, modelId: string): Promise<void> {
    await this.update((config) => {
      config.providers[providerId] = {
        ...config.providers[providerId],
        defaultModel: modelId,
      };
    });
  }

  async setModelSelection(
    providerId: string,
    modelId: string,
    reasoningEffort?: ReasoningEffort,
  ): Promise<void> {
    await this.update((config) => {
      const provider = {
        ...config.providers[providerId],
        defaultModel: modelId,
        ...(reasoningEffort === undefined
          ? {}
          : { defaultReasoningEffort: reasoningEffort }),
      };
      if (reasoningEffort === undefined) {
        delete provider.defaultReasoningEffort;
      }
      config.providers[providerId] = provider;
    });
  }

  async update(
    mutate: (
      config: EulrConfig,
    ) => EulrConfig | void | Promise<EulrConfig | void>,
  ): Promise<EulrConfig> {
    const operation = this.mutationTail.then(async () => {
      const current = await this.load();
      const mutated = await mutate(current);
      const validated = eulrConfigSchema.parse(mutated ?? current);
      await this.save(validated);
      return validated;
    });
    this.mutationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}

export interface ProviderSelectionInput {
  cliProvider?: string;
  config: EulrConfig;
  environment?: NodeJS.ProcessEnv;
  credentialProviderIds: string[];
}

export function selectProvider(input: ProviderSelectionInput): string {
  const environment = input.environment ?? process.env;
  const explicit =
    input.cliProvider ??
    input.config.defaultProvider ??
    environment.EULR_PROVIDER;
  if (explicit) return explicit;

  const unique = [...new Set(input.credentialProviderIds)];
  if (unique.length === 1 && unique[0]) return unique[0];

  if (unique.length > 1) {
    throw new ConfigurationError(
      "More than one provider is authenticated. Choose one with --provider or set a default in config.",
    );
  }

  throw new ConfigurationError(
    "No configured provider is ready. Run `eulr auth login` first.",
  );
}

export function selectModel(
  providerId: string,
  cliModel: string | undefined,
  config: EulrConfig,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return (
    cliModel ??
    config.providers[providerId]?.defaultModel ??
    environment.EULR_MODEL
  );
}

export function selectBaseUrl(
  providerId: string,
  config: EulrConfig,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return config.providers[providerId]?.baseUrl ?? environment.EULR_BASE_URL;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
