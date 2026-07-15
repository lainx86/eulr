import type {
  ModelInfo,
  ReasoningEffort,
  ReasoningEffortInfo,
} from "./provider.js";

export const KNOWN_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export function reasoningOptionsForModel(
  model: ModelInfo,
): ReasoningEffortInfo[] {
  const options = [...(model.supportedReasoningEfforts ?? [])];
  if (
    model.defaultReasoningEffort !== undefined &&
    !options.some(
      (option) => option.effort === model.defaultReasoningEffort,
    )
  ) {
    options.push({ effort: model.defaultReasoningEffort });
  }

  const seen = new Set<string>();
  return options.filter((option) => {
    if (seen.has(option.effort)) return false;
    seen.add(option.effort);
    return true;
  });
}

export function selectReasoningEffort(
  model: ModelInfo | undefined,
  preferred: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  if (model === undefined) return preferred;
  const options = reasoningOptionsForModel(model);
  if (
    preferred !== undefined &&
    (options.length === 0 ||
      options.some((option) => option.effort === preferred))
  ) {
    return preferred;
  }
  return model.defaultReasoningEffort ?? options[0]?.effort;
}

/** Codex Ultra is a client orchestration preset; inference uses Max effort. */
export function codexWireReasoningEffort(
  effort: ReasoningEffort,
): ReasoningEffort {
  return effort === "ultra" ? "max" : effort;
}

export function reasoningEffortLabel(effort: ReasoningEffort): string {
  if (effort === "xhigh") return "Extra high";
  return `${effort.slice(0, 1).toUpperCase()}${effort.slice(1)}`;
}
