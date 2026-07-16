import { Box, Text } from "ink";

import type { ModelCatalogItem, TuiState } from "../types.js";
import { colors } from "../theme/colors.js";
import { symbols } from "../theme/symbols.js";
import { progressBar } from "./view-utils.js";

const QUICK_ACTIONS = [
  ["/help", "Show all commands"],
  ["/model", "Choose an available model"],
  ["/sessions", "Resume a saved session"],
  ["/status", "Inspect the active runtime"],
  ["/login", "Authenticate a provider"],
] as const;

export function WelcomePanel({
  state,
  width,
  height,
}: {
  state: TuiState;
  width: number;
  height: number;
}): React.JSX.Element {
  const cardWidth = Math.max(24, Math.min(width - 6, 104));
  const detailed = cardWidth >= 82 && height >= 22;
  const statusDetailed =
    state.idleView === "status" && detailed && height >= 24;
  const cardHeight = Math.max(
    9,
    Math.min(statusDetailed ? 25 : detailed ? 23 : 14, height - 2),
  );

  return (
    <Box
      width={width}
      height={height}
      justifyContent="center"
      alignItems="flex-end"
      paddingBottom={height >= 4 ? 1 : 0}
      backgroundColor={colors.background}
      overflow="hidden"
    >
      <Box
        width={cardWidth}
        height={cardHeight}
        borderStyle="round"
        borderColor={colors.borderStrong}
        borderBackgroundColor={colors.surface}
        backgroundColor={colors.surface}
        flexDirection="column"
        paddingX={detailed ? 3 : 2}
        paddingY={1}
        overflow="hidden"
      >
        <Box flexDirection="column" flexShrink={0}>
          <Text color={colors.foreground} bold>
            {detailed ? "e u l r  ✦" : "eulr ✦"}
          </Text>
          <Text color={colors.accent}>adaptive coding agent</Text>
          <Text color={colors.borderStrong} wrap="truncate-end">
            {symbols.divider.repeat(
              Math.max(1, cardWidth - (detailed ? 8 : 6)),
            )}
          </Text>
        </Box>

        <Box marginTop={detailed ? 1 : 0} flexDirection="column" flexShrink={0}>
          <Text color={colors.foreground} bold>
            Welcome back.
          </Text>
          {detailed ? (
            <>
              <Text color={colors.foreground} wrap="truncate-end">
                I&apos;m eulr. I adapt to your codebase, your tools, and your
                flow.
              </Text>
              <Text color={colors.muted} wrap="truncate-end">
                Tell me what you&apos;d like to build, explore, or understand.
              </Text>
            </>
          ) : (
            <Text color={colors.muted} wrap="truncate-end">
              Tell me what you want to build, explore, or understand.
            </Text>
          )}
        </Box>

        {detailed ? (
          <DetailedContent state={state} cardWidth={cardWidth} />
        ) : (
          <CompactContent state={state} />
        )}
      </Box>
    </Box>
  );
}

function DetailedContent({
  state,
  cardWidth,
}: {
  state: TuiState;
  cardWidth: number;
}): React.JSX.Element {
  const contentWidth = Math.max(1, cardWidth - 8);
  const actionWidth = Math.max(36, Math.floor(contentWidth * 0.56));
  const models = visibleModels(state);
  return (
    <Box marginTop={1} flexDirection="column" flexGrow={1} overflow="hidden">
      <Box flexGrow={1} overflow="hidden">
        <Box width={actionWidth} paddingRight={2} flexDirection="column">
          {state.idleView === "status" ? (
            <RuntimeStatus state={state} width={actionWidth - 2} />
          ) : (
            <>
              <Text color={colors.accent} bold>
                {symbols.selected} Get started
              </Text>
              <Box marginTop={1} flexDirection="column">
                {QUICK_ACTIONS.map(([command, description]) => (
                  <Box key={command} height={1} overflow="hidden">
                    <Box width={14}>
                      <Text color={colors.accent}>{command}</Text>
                    </Box>
                    <Text color={colors.muted} wrap="truncate-end">
                      {description}
                    </Text>
                  </Box>
                ))}
              </Box>
            </>
          )}
        </Box>
        <Box
          flexGrow={1}
          borderStyle="single"
          borderLeft
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor={colors.border}
          borderLeftBackgroundColor={colors.surface}
          paddingLeft={3}
          flexDirection="column"
          overflow="hidden"
        >
          <Text color={colors.accent} bold>
            {symbols.selected} Available models
          </Text>
          <Box marginTop={1} flexDirection="column" overflow="hidden">
            {models.slice(0, 5).map((model, index) => (
              <ModelRow
                key={`${model.id}-${index}`}
                model={model}
                active={model.id === state.model}
              />
            ))}
            {state.modelCatalog.status === "loading" && (
              <Text color={colors.muted} wrap="truncate-end">
                ◌ Refreshing provider catalog…
              </Text>
            )}
            {state.modelCatalog.status === "failed" && (
              <Text color={colors.warning} wrap="truncate-end">
                ! Catalog unavailable; active model retained
              </Text>
            )}
          </Box>
          <Box marginTop={1}>
            <Text color={colors.muted} wrap="truncate-end">
              {state.providerId} · {catalogSummary(state)}
            </Text>
          </Box>
        </Box>
      </Box>
      <Box
        borderStyle="single"
        borderTop
        borderLeft={false}
        borderRight={false}
        borderBottom={false}
        borderColor={colors.border}
        borderTopBackgroundColor={colors.surface}
        paddingTop={0}
        justifyContent="space-between"
        overflow="hidden"
        flexShrink={0}
      >
        <Text color={colors.muted} wrap="truncate-middle">
          workspace · {state.cwd}
        </Text>
        <Text color={colors.muted}>session · {state.sessionId}</Text>
      </Box>
    </Box>
  );
}

function CompactContent({ state }: { state: TuiState }): React.JSX.Element {
  if (state.idleView === "status") {
    const contextWindow = activeContextWindow(state);
    return (
      <Box marginTop={1} flexDirection="column" overflow="hidden">
        <Text color={colors.accent} bold>
          {symbols.selected} Runtime status
        </Text>
        <Text color={colors.foreground} wrap="truncate-end">
          {state.model}
          {state.reasoningEffort === undefined
            ? ""
            : ` · reasoning ${state.reasoningEffort}`}
        </Text>
        <Text color={colors.muted} wrap="truncate-end">
          {state.providerId} · {state.sessionId} ·{" "}
          {state.runtimeStatus.sessionStatus}
        </Text>
        <Text color={colors.muted} wrap="truncate-end">
          {formatCount(state.usage.inputTokens)} in ·{" "}
          {formatCount(state.usage.outputTokens)} out · context ~
          {formatCount(state.runtimeStatus.estimatedContextTokens)}
          {contextWindow === undefined
            ? ""
            : ` / ${formatCount(contextWindow)}`}
        </Text>
      </Box>
    );
  }
  return (
    <Box marginTop={1} flexDirection="column" overflow="hidden">
      <Box columnGap={2} overflow="hidden">
        {QUICK_ACTIONS.slice(0, 4).map(([command]) => (
          <Text key={command} color={colors.accent}>
            {command}
          </Text>
        ))}
      </Box>
      <Text color={colors.muted} wrap="truncate-end">
        model · {state.model}
        {state.reasoningEffort === undefined
          ? ""
          : ` · reasoning ${state.reasoningEffort}`}{" "}
        · {catalogSummary(state)}
      </Text>
      <Text color={colors.muted} wrap="truncate-middle">
        workspace · {state.cwd}
      </Text>
    </Box>
  );
}

function RuntimeStatus({
  state,
  width,
}: {
  state: TuiState;
  width: number;
}): React.JSX.Element {
  const status = state.runtimeStatus;
  const contextWindow = activeContextWindow(state);
  const contextRatio =
    contextWindow === undefined || contextWindow <= 0
      ? 0
      : status.estimatedContextTokens / contextWindow;
  const account =
    status.account === undefined
      ? authenticationLabel(status.authenticationMethod)
      : `${status.account}${status.plan === undefined ? "" : ` (${titleCase(status.plan)})`}`;
  const permission =
    status.permissionMode === "auto"
      ? "workspace · normal operations auto-approved"
      : "workspace · ask for approval";
  const usage = `${formatCount(state.usage.inputTokens)} in · ${formatCount(state.usage.outputTokens)} out${state.usage.cachedInputTokens > 0 ? ` · ${formatCount(state.usage.cachedInputTokens)} cached` : ""}`;
  const context = `~${formatCount(status.estimatedContextTokens)}${contextWindow === undefined ? "" : ` / ${formatCount(contextWindow)}`} · ${status.activeMessages} message${status.activeMessages === 1 ? "" : "s"}`;

  return (
    <Box flexDirection="column" overflow="hidden">
      <Text color={colors.accent} bold>
        {symbols.selected} Runtime status · eulr v{state.version}
      </Text>
      <Box marginTop={1} flexDirection="column" overflow="hidden">
        <StatusRow
          label="Model"
          value={`${state.model}${state.reasoningEffort === undefined ? "" : ` · reasoning ${state.reasoningEffort}`}`}
        />
        <StatusRow
          label="Provider"
          value={`${state.providerId} · ${authenticationLabel(status.authenticationMethod)}`}
        />
        <StatusRow label="Directory" value={state.cwd} />
        <StatusRow label="Permissions" value={permission} />
        <StatusRow label="Account" value={account} />
        <StatusRow
          label="Session"
          value={`${state.sessionId} · ${status.sessionStatus}`}
        />
        <StatusRow label="Usage" value={usage} />
        <StatusRow label="Context" value={context} />
        {contextWindow !== undefined && (
          <Box height={1} overflow="hidden">
            <Box width={13} />
            <Text color={colors.accent}>
              {progressBar(contextRatio, Math.max(6, Math.min(22, width - 15)))}
            </Text>
            <Text color={colors.muted}>
              {" "}
              {Math.round(Math.min(1, contextRatio) * 100)}%
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

function StatusRow({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.JSX.Element {
  return (
    <Box height={1} overflow="hidden">
      <Box width={13} flexShrink={0}>
        <Text color={colors.muted}>{label}</Text>
      </Box>
      <Text color={colors.foreground} wrap="truncate-middle">
        {value}
      </Text>
    </Box>
  );
}

function activeContextWindow(state: TuiState): number | undefined {
  return (
    state.runtimeStatus.contextWindow ??
    state.modelCatalog.models.find((model) => model.id === state.model)
      ?.contextWindow
  );
}

function authenticationLabel(
  method: TuiState["runtimeStatus"]["authenticationMethod"],
): string {
  if (method === "chatgpt") return "ChatGPT subscription";
  if (method === "api-key") return "API credential";
  return "provider credential";
}

function formatCount(value: number): string {
  if (value >= 1_000_000)
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000)
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return String(value);
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function ModelRow({
  model,
  active,
}: {
  model: ModelCatalogItem;
  active: boolean;
}): React.JSX.Element {
  return (
    <Box height={1} justifyContent="space-between" overflow="hidden">
      <Box flexGrow={1} overflow="hidden">
        <Text
          color={active ? colors.accent : colors.foreground}
          bold={active}
          wrap="truncate-end"
        >
          {active ? "●" : "·"} {model.id}
        </Text>
      </Box>
      {active && <Text color={colors.muted}>active</Text>}
    </Box>
  );
}

function visibleModels(state: TuiState): ModelCatalogItem[] {
  const models = [...state.modelCatalog.models];
  if (!models.some((model) => model.id === state.model)) {
    models.unshift({ id: state.model });
  }
  return models;
}

function catalogSummary(state: TuiState): string {
  if (state.modelCatalog.status === "loading") return "loading catalog";
  if (state.modelCatalog.status === "failed") return "catalog unavailable";
  const count = state.modelCatalog.models.length;
  return `${count} model${count === 1 ? "" : "s"} available`;
}
