import { createRequire } from "node:module";
import { realpath, stat } from "node:fs/promises";

import { Agent } from "../agent/agent.js";
import { ContextManager } from "../agent/context-manager.js";
import type { AgentEventSink } from "../agent/events.js";
import { AgentLoop } from "../agent/loop.js";
import { AuthService } from "../auth/auth-service.js";
import { CredentialStore } from "../auth/credential-store.js";
import { redactText, sanitizeError } from "../auth/redaction.js";
import {
  ConfigStore,
  selectBaseUrl,
  selectModel,
  selectProvider,
} from "../config/config-store.js";
import { getEulrPaths } from "../config/data-paths.js";
import type { EulrConfig } from "../config/schema.js";
import { PermissionManager } from "../permissions/permission-manager.js";
import type {
  PermissionDecision,
  PermissionRequest,
} from "../permissions/types.js";
import { OpenAICodexProvider } from "../providers/openai-codex.js";
import { OpenAICompatibleProvider } from "../providers/openai-compatible.js";
import type { ModelInfo, ModelProvider } from "../providers/provider.js";
import type { ReasoningEffort } from "../providers/provider.js";
import { selectReasoningEffort } from "../providers/reasoning.js";
import { ProviderRegistry } from "../providers/registry.js";
import { SessionService } from "../sessions/session-service.js";
import type { SessionState } from "../sessions/state.js";
import { SessionStore } from "../sessions/store.js";
import { createDefaultToolRegistry } from "../tools/registry.js";
import {
  AgentTuiEventBridge,
  TuiPermissionBroker,
} from "../tui/event-bridge.js";
import { TuiRuntimeBindings } from "../tui/runtime-bindings.js";
import { TuiStore } from "../tui/state/tui-store.js";
import {
  configureTuiColorEnvironment,
  supportsTui,
} from "../tui/terminal-lifecycle.js";
import { TuiController } from "../tui/tui-controller.js";
import {
  AuthenticationError,
  ConfigurationError,
  errorMessage,
  isAbortError,
  ProviderError,
} from "../utils/errors.js";
import { HELP_TEXT, parseArgs, type CliArgs } from "./args.js";
import {
  CancellationCoordinator,
  runInteractive,
  type InteractiveRuntime,
} from "./interactive.js";
import { PromptService } from "./prompts.js";
import { TerminalRenderer } from "./renderer.js";

const require = createRequire(import.meta.url);
const packageJson = require("../../package.json") as { version: string };
export const VERSION = packageJson.version;

interface AppServices {
  configStore: ConfigStore;
  credentials: CredentialStore;
  auth: AuthService;
  sessions: SessionService;
}

interface RuntimeRequest {
  providerId?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  cwd?: string;
  sessionId?: string;
  yes: boolean;
}

interface RuntimePresentation {
  emit: AgentEventSink;
  confirmPermission(request: PermissionRequest): Promise<PermissionDecision>;
  warning(message: string): void;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  const debugRequested = argv.includes("--debug");
  try {
    args = parseArgs(argv);
  } catch (error) {
    const renderer = new TerminalRenderer(
      process.stdout,
      process.stderr,
      debugRequested,
    );
    renderer.error(errorMessage(error));
    renderer.line("Run `eulr --help` for usage.");
    return 2;
  }

  const renderer = new TerminalRenderer(
    process.stdout,
    process.stderr,
    args.debug,
  );
  if (args.help) {
    renderer.line(HELP_TEXT.trimEnd());
    return 0;
  }
  if (args.version) {
    renderer.line(VERSION);
    return 0;
  }

  const paths = getEulrPaths();
  const configStore = new ConfigStore(paths.configFile);
  const credentials = new CredentialStore({ path: paths.authFile });
  const auth = new AuthService(credentials);
  const sessions = new SessionService(
    new SessionStore({ directory: paths.sessionsDir }),
  );
  const services: AppServices = { configStore, credentials, auth, sessions };
  const prompts = new PromptService();
  const cancellation = new CancellationCoordinator();

  try {
    switch (args.command) {
      case "auth-login":
        cancellation.install();
        await cancellation.run(async (signal) => {
          const providerId = await performLogin(
            args,
            services,
            prompts,
            renderer,
            signal,
          );
          renderer.line(`Authenticated provider: ${providerId}`);
        });
        return 0;
      case "auth-logout":
        await logout(args, services, renderer);
        return 0;
      case "auth-status":
        await showAuthStatus(args, services, renderer);
        return 0;
      case "models":
        await showModelsCommand(args, services, renderer);
        return 0;
      case "sessions":
        await showSessionsCommand(services.sessions, renderer);
        return 0;
      case "run":
        break;
    }

    const terminalSupportsTui = supportsTui();
    if (args.tui && !terminalSupportsTui) {
      throw new ConfigurationError(
        "--tui requires interactive stdin/stdout and a terminal with TERM support. Use --plain in this environment.",
      );
    }
    const useTui = args.tui || (!args.plain && terminalSupportsTui);
    const runtimeRequest: RuntimeRequest = {
      providerId: args.provider,
      model: args.model,
      cwd: args.cwd,
      sessionId: args.resume,
      yes: args.yes,
    };

    if (useTui) {
      configureTuiColorEnvironment();
      const { runTui } = await import("../tui/tui-runtime.js");
      const bindings = new TuiRuntimeBindings(() => cancellation.signal);
      const presentation: RuntimePresentation = {
        emit: bindings.emit,
        confirmPermission: bindings.confirmPermission,
        warning: bindings.warning,
      };
      const runtime = await createRuntime(
        runtimeRequest,
        services,
        presentation,
      );
      const store = new TuiStore({
        providerId: runtime.providerId,
        model: runtime.model,
        ...(runtime.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: runtime.reasoningEffort }),
        cwd: runtime.cwd,
        session: runtime.session,
        version: VERSION,
        ...(runtime.authentication === undefined
          ? {}
          : { authentication: runtime.authentication }),
        ...(runtime.autoApprove === undefined
          ? {}
          : { autoApprove: runtime.autoApprove }),
        ...(runtime.contextWindow === undefined
          ? {}
          : { contextWindow: runtime.contextWindow }),
      });
      const bridge = new AgentTuiEventBridge(store);
      const permissionBroker = new TuiPermissionBroker(store);
      bindings.attach({ bridge, permissions: permissionBroker, store });
      const controller = new TuiController({
        runtime,
        store,
        permissions: permissionBroker,
        cancellation,
        actions: {
          login: async (signal, current) => {
            const loginArgs: CliArgs = {
              ...args,
              command: "auth-login",
              device: false,
            };
            const providerId = await performLogin(
              loginArgs,
              services,
              prompts,
              renderer,
              signal,
            );
            return createRuntime(
              { providerId, yes: args.yes, cwd: current.cwd },
              services,
              presentation,
            );
          },
          logout: (providerId) => services.auth.logout(providerId),
          newSession: (current) =>
            createRuntime(
              {
                providerId: current.providerId,
                model: current.model,
                ...(current.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: current.reasoningEffort }),
                cwd: current.cwd,
                yes: args.yes,
              },
              services,
              presentation,
            ),
          resume: (sessionId) =>
            createRuntime({ sessionId, yes: args.yes }, services, presentation),
          saveModel: (providerId, modelId, reasoningEffort) =>
            services.configStore.setModelSelection(
              providerId,
              modelId,
              reasoningEffort,
            ),
        },
      });
      await runTui({
        store,
        controller,
        debug: args.debug,
        ...(args.task === undefined ? {} : { initialTask: args.task }),
      });
      return 0;
    }

    cancellation.install();
    const presentation: RuntimePresentation = {
      emit: renderer.eventSink(),
      confirmPermission: (request) =>
        prompts.confirmPermission(request, cancellation.signal),
      warning: (message) => renderer.line(`Warning: ${message}`),
    };
    const runtime = await createRuntime(runtimeRequest, services, presentation);

    if (args.task !== undefined) {
      try {
        await cancellation.run(async (signal) => {
          await runtime.agent.run(args.task ?? "", { signal });
        });
        renderer.line();
        await services.sessions.flush();
        return 0;
      } catch (error) {
        await services.sessions.flush();
        if (isAbortError(error)) {
          renderer.line("Cancelled.");
          return 130;
        }
        throw error;
      }
    }

    await runInteractive({
      runtime,
      prompts,
      renderer,
      cancellation,
      login: async (signal) => {
        const loginArgs: CliArgs = {
          ...args,
          command: "auth-login",
          device: false,
        };
        const providerId = await performLogin(
          loginArgs,
          services,
          prompts,
          renderer,
          signal,
        );
        return createRuntime(
          { providerId, yes: args.yes, cwd: runtime.cwd },
          services,
          presentation,
        );
      },
      logout: (providerId) => services.auth.logout(providerId),
      newSession: (current) =>
        createRuntime(
          {
            providerId: current.providerId,
            model: current.model,
            ...(current.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: current.reasoningEffort }),
            cwd: current.cwd,
            yes: args.yes,
          },
          services,
          presentation,
        ),
      resume: (sessionId) =>
        createRuntime({ sessionId, yes: args.yes }, services, presentation),
      saveModel: (providerId, modelId, reasoningEffort) =>
        services.configStore.setModelSelection(
          providerId,
          modelId,
          reasoningEffort,
        ),
    });
    return 0;
  } catch (error) {
    const sanitized = sanitizeError(error);
    renderer.error(sanitized.message);
    if (args.debug && sanitized.stack) renderer.debug(sanitized.stack);
    return isAbortError(error) ? 130 : 1;
  } finally {
    cancellation.dispose();
    await services.sessions.flush().catch(() => undefined);
  }
}

async function createRuntime(
  request: RuntimeRequest,
  services: AppServices,
  presentation: RuntimePresentation,
): Promise<InteractiveRuntime> {
  const config = await services.configStore.load();
  let resumed: SessionState | undefined;
  if (request.sessionId !== undefined) {
    resumed = await services.sessions.load(request.sessionId);
    if (
      request.providerId !== undefined &&
      request.providerId !== resumed.provider
    ) {
      throw new ConfigurationError(
        `Session ${resumed.id} uses ${resumed.provider}, not ${request.providerId}.`,
      );
    }
    if (request.cwd !== undefined) {
      const requestedCwd = await validateCwd(request.cwd);
      if (requestedCwd !== resumed.cwd) {
        throw new ConfigurationError(
          `Session ${resumed.id} belongs to ${resumed.cwd}, not ${requestedCwd}.`,
        );
      }
    }
  }

  const readyProviderIds = await services.auth.readyProviderIds();
  if (process.env.EULR_API_KEY) readyProviderIds.push("openai-compatible");
  const providerId =
    resumed?.provider ??
    selectProvider({
      cliProvider: request.providerId,
      config,
      credentialProviderIds: readyProviderIds,
    });
  const configuredModel =
    request.model ??
    resumed?.model ??
    selectModel(providerId, undefined, config);
  const provider = createProvider(
    providerId,
    configuredModel,
    config,
    services.auth,
    presentation.warning,
  );
  const { model, info } = await resolveModel(
    providerId,
    configuredModel,
    provider,
    presentation.warning,
  );
  const preferredReasoningEffort =
    request.reasoningEffort ??
    resumed?.reasoningEffort ??
    config.providers[providerId]?.defaultReasoningEffort;
  const reasoningEffort =
    providerId === "openai-codex"
      ? selectReasoningEffort(info, preferredReasoningEffort)
      : undefined;
  const cwd = resumed?.cwd ?? (await validateCwd(request.cwd ?? process.cwd()));
  const session =
    resumed === undefined
      ? await services.sessions.create({
          cwd,
          provider: providerId,
          model,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        })
      : await services.sessions.resume(resumed.id);
  if (session.model !== model)
    await services.sessions.setModel(session.id, model);
  if (session.reasoningEffort !== reasoningEffort) {
    await services.sessions.setReasoningEffort(session.id, reasoningEffort);
  }
  const activeSession =
    session.model === model && session.reasoningEffort === reasoningEffort
      ? session
      : await services.sessions.load(session.id);
  const permissions = new PermissionManager({
    yes: request.yes,
    prompt: presentation.confirmPermission,
  });
  const loop = new AgentLoop({
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    tools: createDefaultToolRegistry(),
    permissions,
    sessions: services.sessions,
    context: new ContextManager({
      ...(info?.contextWindow ? { contextWindow: info.contextWindow } : {}),
    }),
    emit: presentation.emit,
  });
  const agent = new Agent(loop, services.sessions, activeSession);
  const [authentication] = await services.auth.status(providerId);
  return {
    providerId,
    provider,
    model,
    reasoningEffort,
    ...(authentication === undefined
      ? {}
      : {
          authentication: {
            ...(authentication.method === undefined
              ? {}
              : { method: authentication.method }),
            ...(authentication.email === undefined
              ? {}
              : { account: authentication.email }),
            ...(authentication.planType === undefined
              ? {}
              : { plan: authentication.planType }),
          },
        }),
    autoApprove: request.yes === true,
    ...(info?.contextWindow === undefined
      ? {}
      : { contextWindow: info.contextWindow }),
    cwd,
    session: activeSession,
    sessions: services.sessions,
    loop,
    agent,
  };
}

function createProvider(
  providerId: string,
  model: string | undefined,
  config: EulrConfig,
  auth: AuthService,
  onWarning?: (message: string) => void,
): ModelProvider {
  const codex = new OpenAICodexProvider({
    auth,
    ...(model ? { configuredModel: model } : {}),
    ...(onWarning ? { onWarning } : {}),
    ...(config.providers["openai-codex"]?.baseUrl
      ? { baseUrl: config.providers["openai-codex"].baseUrl }
      : {}),
  });
  const compatible = new OpenAICompatibleProvider({
    auth,
    ...(selectBaseUrl("openai-compatible", config)
      ? { baseUrl: selectBaseUrl("openai-compatible", config) }
      : {}),
    ...(model ? { model } : {}),
  });
  return new ProviderRegistry([codex, compatible]).get(providerId);
}

export async function resolveModel(
  providerId: string,
  configuredModel: string | undefined,
  provider: ModelProvider,
  onWarning?: (message: string) => void,
): Promise<{ model: string; info?: ModelInfo }> {
  if (configuredModel !== undefined) {
    if (providerId !== "openai-codex") return { model: configuredModel };
    try {
      const configuredInfo = (await provider.listModels()).find(
        (model) => model.id === configuredModel,
      );
      return configuredInfo === undefined
        ? { model: configuredModel }
        : { model: configuredModel, info: configuredInfo };
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      onWarning?.(
        redactText(
          `Codex model catalog refresh failed; using explicitly configured model ${configuredModel}. ${sanitizeError(error).message}`,
        ),
      );
      return { model: configuredModel };
    }
  }
  if (providerId === "openai-compatible") {
    throw new ConfigurationError(
      "No model configured for openai-compatible. Use --model, EULR_MODEL, or set a provider default.",
    );
  }
  const models = await provider.listModels();
  const first = models[0];
  if (first === undefined) {
    throw new ConfigurationError(
      "The active provider returned no available models.",
    );
  }
  return { model: first.id, info: first };
}

async function performLogin(
  args: CliArgs,
  services: AppServices,
  prompts: PromptService,
  renderer: TerminalRenderer,
  signal: AbortSignal,
): Promise<string> {
  let providerId: "openai-codex" | "openai-compatible";
  if (args.provider !== undefined) {
    if (
      args.provider !== "openai-codex" &&
      args.provider !== "openai-compatible"
    ) {
      throw new ConfigurationError(`Unknown provider: ${args.provider}`);
    }
    providerId = args.provider;
  } else if (args.device) {
    providerId = "openai-codex";
  } else {
    providerId = await prompts.chooseAuthentication(signal);
  }
  if (args.device && providerId !== "openai-codex") {
    throw new ConfigurationError(
      "--device is only supported for ChatGPT login.",
    );
  }

  const config = await services.configStore.load();
  if (providerId === "openai-codex") {
    if (args.device) {
      await services.auth.loginChatGPTDevice({
        signal,
        onUserCode: ({ verificationUrl, userCode }) => {
          renderer.line(
            `Open this URL in a browser:\n${verificationUrl}\n\nEnter this code:\n${userCode}\n\nWaiting for authentication...`,
          );
        },
      });
    } else {
      await services.auth.loginChatGPTBrowser({
        signal,
        ...(process.env.EULR_NO_BROWSER
          ? { openBrowser: async () => false }
          : {}),
        onAuthorizationUrl: (url, browserOpened) => {
          if (browserOpened)
            renderer.line("Browser opened. Waiting for authentication...");
          else
            renderer.line(
              `Open this URL in a browser:\n${url}\n\nWaiting for authentication...`,
            );
        },
      });
    }
  } else {
    const apiKey = (await prompts.readSecret("API key: ", signal)).trim();
    if (apiKey === "")
      throw new AuthenticationError("API key cannot be empty.");
    const baseUrl = (
      await prompts.ask("Base URL (blank for SDK default): ", signal)
    ).trim();
    const model = (await prompts.ask("Default model: ", signal)).trim();
    if (model === "")
      throw new ConfigurationError("A default model is required.");
    await services.auth.saveApiCredential({
      apiKey,
      ...(baseUrl ? { baseUrl } : {}),
    });
    config.providers[providerId] = {
      defaultModel: model,
      ...(baseUrl ? { baseUrl } : {}),
    };
  }
  config.defaultProvider = providerId;
  config.providers[providerId] ??= {};
  await services.configStore.save(config);
  return providerId;
}

async function logout(
  args: CliArgs,
  services: AppServices,
  renderer: TerminalRenderer,
): Promise<void> {
  const config = await services.configStore.load();
  const providerId = selectProvider({
    cliProvider: args.provider,
    config,
    credentialProviderIds: await services.credentials.listProviderIds(),
  });
  const removed = await services.auth.logout(providerId);
  renderer.line(
    removed
      ? `Logged out from ${providerId}.`
      : `No stored credential for ${providerId}.`,
  );
}

async function showAuthStatus(
  args: CliArgs,
  services: AppServices,
  renderer: TerminalRenderer,
): Promise<void> {
  const statuses = await services.auth.status(args.provider);
  if (statuses.length === 0 && !process.env.EULR_API_KEY) {
    renderer.line("No stored credentials. Run `eulr auth login`.");
    return;
  }
  for (const status of statuses) {
    if (!status.authenticated) {
      renderer.line(`${status.providerId}: not authenticated`);
      continue;
    }
    const details: string[] = status.method ? [status.method] : [];
    if (status.email) details.push(status.email);
    if (status.expiresAt)
      details.push(`expires ${new Date(status.expiresAt).toISOString()}`);
    if (status.baseUrl) details.push(status.baseUrl);
    renderer.line(
      `${status.providerId}: authenticated (${details.filter(Boolean).join(", ")})`,
    );
  }
  if (
    process.env.EULR_API_KEY &&
    !statuses.some((status) => status.providerId === "openai-compatible")
  ) {
    renderer.line("openai-compatible: authenticated (environment API key)");
  }
}

async function showModelsCommand(
  args: CliArgs,
  services: AppServices,
  renderer: TerminalRenderer,
): Promise<void> {
  const config = await services.configStore.load();
  const ready = await services.auth.readyProviderIds();
  if (process.env.EULR_API_KEY) ready.push("openai-compatible");
  const providerId = selectProvider({
    cliProvider: args.provider,
    config,
    credentialProviderIds: ready,
  });
  const activeModel = selectModel(providerId, args.model, config);
  const provider = createProvider(
    providerId,
    activeModel,
    config,
    services.auth,
    (message) => renderer.line(`Warning: ${message}`),
  );
  const models = await provider.listModels();
  const selected = activeModel ?? models[0]?.id;
  if (models.length === 0) {
    renderer.line("No models returned by the active provider.");
    return;
  }
  for (const model of models) {
    renderer.line(
      `${model.id === selected ? "*" : " "} ${model.id}${model.name ? ` - ${model.name}` : ""}`,
    );
  }
}

async function showSessionsCommand(
  sessions: SessionService,
  renderer: TerminalRenderer,
): Promise<void> {
  const states = await sessions.list();
  if (states.length === 0) {
    renderer.line("No saved sessions.");
    return;
  }
  for (const state of states) {
    renderer.line(
      `${state.id}  ${state.status.padEnd(9)}  ${state.provider}  ${state.model}  ${state.cwd}`,
    );
  }
}

async function validateCwd(cwd: string): Promise<string> {
  try {
    const canonical = await realpath(cwd);
    if (!(await stat(canonical)).isDirectory()) {
      throw new ConfigurationError(
        `Working directory is not a directory: ${cwd}`,
      );
    }
    return canonical;
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(`Working directory is unavailable: ${cwd}`, {
      cause: error,
    });
  }
}
