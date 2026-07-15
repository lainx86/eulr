import type { TokenUsage } from "../agent/messages.js";
import type { PermissionRequest } from "../permissions/types.js";
import type {
  ReasoningEffort,
  ReasoningEffortInfo,
} from "../providers/provider.js";

export type RunPhase =
  "idle" | "working" | "completed" | "failed" | "cancelled";

export type CompanionState =
  | "idle"
  | "thinking"
  | "reading"
  | "editing"
  | "running"
  | "waiting_permission"
  | "completed"
  | "error"
  | "cancelled";

export type ActivityStatus =
  "queued" | "active" | "completed" | "failed" | "cancelled";

export type InspectorTab = "changes" | "file" | "output" | "answer";
export type FocusTarget = "activity" | "inspector" | "input" | "music";

export interface ActivityItem {
  id: string;
  label: string;
  status: ActivityStatus;
  detail?: string;
  callId?: string;
  toolName?: string;
  timestamp: number;
}

export interface FileViewState {
  path: string;
  content: string;
  language?: string;
  truncated?: boolean;
}

export interface FileChangeState {
  path: string;
  before: string | null;
  after: string;
  truncated?: boolean;
}

export interface OutputViewState {
  command: string;
  stdout: string;
  stderr: string;
  exitCode?: number | null;
  running: boolean;
  truncated?: boolean;
}

export interface InspectorState {
  activeTab: InspectorTab;
  manuallySelected: boolean;
  file?: FileViewState;
  change?: FileChangeState;
  output?: OutputViewState;
  answer: string;
}

export interface PermissionUiState {
  request: PermissionRequest;
}

export interface OverlayItem {
  id: string;
  label: string;
  detail?: string;
}

export type OverlayState =
  | { type: "help" }
  | {
      type: "models" | "sessions";
      title: string;
      items: OverlayItem[];
      selectedIndex: number;
    }
  | {
      type: "reasoning";
      title: string;
      modelId: string;
      items: OverlayItem[];
      selectedIndex: number;
    };

export interface MusicUiState {
  available: boolean;
  statusMessage: string;
  playing: boolean;
  track?: {
    id: string;
    title: string;
    artist?: string;
    album?: string;
    path?: string;
  };
  elapsedSeconds: number;
  durationSeconds: number;
  volume: number;
  shuffle: boolean;
  repeat: boolean;
  libraryPath?: string;
  librarySource?: "builtin" | "user";
  trackIndex: number;
  trackCount: number;
}

export interface ModelCatalogItem {
  id: string;
  name?: string;
  defaultReasoningEffort?: ReasoningEffort;
  supportedReasoningEfforts?: ReasoningEffortInfo[];
}

export interface ModelCatalogUiState {
  providerId: string;
  status: "loading" | "ready" | "failed";
  models: ModelCatalogItem[];
  error?: string;
}

export interface ScrollState {
  activity: number;
  inspector: Record<InspectorTab, { vertical: number; horizontal: number }>;
}

export interface TuiState {
  providerId: string;
  model: string;
  reasoningEffort: ReasoningEffort | undefined;
  cwd: string;
  sessionId: string;
  version: string;
  phase: RunPhase;
  task?: string;
  queuedFollowUp?: string;
  activities: ActivityItem[];
  inspector: InspectorState;
  permission?: PermissionUiState;
  companion: CompanionState;
  focus: FocusTarget;
  overlay?: OverlayState;
  statusMessage: string;
  usage: TokenUsage;
  modelCatalog: ModelCatalogUiState;
  music: MusicUiState;
  scroll: ScrollState;
  frame: number;
}

export const emptyMusicUiState = (): MusicUiState => ({
  available: false,
  statusMessage: "No tracks loaded",
  playing: false,
  elapsedSeconds: 0,
  durationSeconds: 0,
  volume: 70,
  shuffle: false,
  repeat: false,
  trackIndex: -1,
  trackCount: 0,
});
