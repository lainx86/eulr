import { ConfigurationError } from "../utils/errors.js";
import type { ModelProvider } from "./provider.js";

export class ProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();

  constructor(providers: readonly ModelProvider[] = []) {
    for (const provider of providers) {
      this.register(provider);
    }
  }

  register(provider: ModelProvider): void {
    if (this.providers.has(provider.id)) {
      throw new ConfigurationError(
        `Provider is already registered: ${provider.id}`,
      );
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): ModelProvider {
    const provider = this.providers.get(id);
    if (provider === undefined) {
      throw new ConfigurationError(
        `Unknown provider: ${id}. Available: ${this.ids().join(", ") || "none"}`,
      );
    }
    return provider;
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  list(): ModelProvider[] {
    return [...this.providers.values()];
  }

  ids(): string[] {
    return [...this.providers.keys()].sort();
  }
}
