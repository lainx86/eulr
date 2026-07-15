import { Box, Text } from "ink";

import type { ModelCatalogItem, TuiState } from "../types.js";
import { colors } from "../theme/colors.js";
import { symbols } from "../theme/symbols.js";

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
  const cardHeight = Math.max(9, Math.min(detailed ? 23 : 14, height - 2));

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
          : ` · reasoning ${state.reasoningEffort}`} · {catalogSummary(state)}
      </Text>
      <Text color={colors.muted} wrap="truncate-middle">
        workspace · {state.cwd}
      </Text>
    </Box>
  );
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
