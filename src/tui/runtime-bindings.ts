import type { AgentEvent, AgentEventSink } from "../agent/events.js";
import type {
  PermissionDecision,
  PermissionRequest,
} from "../permissions/types.js";
import { PermissionDeniedError } from "../utils/errors.js";
import type {
  AgentTuiEventBridge,
  TuiPermissionBroker,
} from "./event-bridge.js";
import type { TuiStore } from "./state/tui-store.js";

/** Mutable presentation proxy shared by every runtime created within one TUI. */
export class TuiRuntimeBindings {
  private bridge?: AgentTuiEventBridge;
  private permissions?: TuiPermissionBroker;
  private store?: TuiStore;
  private readonly pendingWarnings: string[] = [];

  constructor(private readonly activeSignal: () => AbortSignal | undefined) {}

  readonly emit: AgentEventSink = (event: AgentEvent): void => {
    this.bridge?.handle(event);
  };

  readonly confirmPermission = (
    request: PermissionRequest,
  ): Promise<PermissionDecision> => {
    if (this.permissions === undefined) {
      return Promise.reject(
        new PermissionDeniedError("Permission UI is not available"),
      );
    }
    return this.permissions.request(request, this.activeSignal());
  };

  readonly warning = (message: string): void => {
    if (this.store === undefined) {
      this.pendingWarnings.push(message);
      return;
    }
    this.store.setStatus(`Warning: ${message}`);
  };

  attach(input: {
    bridge: AgentTuiEventBridge;
    permissions: TuiPermissionBroker;
    store: TuiStore;
  }): void {
    this.bridge = input.bridge;
    this.permissions = input.permissions;
    this.store = input.store;
    const warning = this.pendingWarnings.at(-1);
    this.pendingWarnings.length = 0;
    if (warning !== undefined) this.warning(warning);
  }
}
