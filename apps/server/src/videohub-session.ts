import { EventEmitter } from "node:events";
import net from "node:net";

import type {
  DeviceConfig,
  LockState,
  PendingRoute,
  ProtocolEventType,
  RoutePoint,
  ServerEvent,
  VideohubSnapshot,
} from "@blackmagic-enhanced-router/shared";
import {
  PROTOCOL_HEADERS,
  ProtocolStreamParser,
  serializePing,
  serializeStatusDumpRequest,
  serializeVideoOutputRoute,
  type ParsedProtocolBlock,
} from "@blackmagic-enhanced-router/videohub-protocol";

const RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
const PING_INTERVAL_MS = 15000;
const DEGRADED_THRESHOLD_MS = 30000;
const ROUTE_CONFIRMATION_TIMEOUT_MS = 2000;
const ROUTE_DUMP_REQUEST_DELAY_MS = 120;
const ACK_TIMEOUT_MS = 2000;

type SnapshotBlockFlags = {
  protocol: boolean;
  device: boolean;
  inputLabels: boolean;
  outputLabels: boolean;
  routes: boolean;
  locks: boolean;
};

type AckWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const createEmptySnapshot = (): VideohubSnapshot => ({
  connection: {
    state: "disconnected",
    ready: false,
  },
  device: {
    protocolVersion: "unknown",
    devicePresent: false,
  },
  inputs: [],
  outputs: [],
  routes: [],
  outputLocks: [],
});

const mergeLabels = (
  current: VideohubSnapshot["inputs"] | VideohubSnapshot["outputs"],
  updates: Array<{ index: number; name: string }>,
) => {
  const next = new Map(current.map((entry) => [entry.index, entry.name]));
  for (const update of updates) {
    next.set(update.index, update.name);
  }

  return [...next.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([index, name]) => ({ index, name }));
};

const mergeRoutes = (current: RoutePoint[], updates: RoutePoint[]) => {
  const next = new Map(current.map((route) => [route.output, route.input]));
  for (const update of updates) {
    next.set(update.output, update.input);
  }

  return [...next.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([output, input]) => ({ output, input }));
};

const mergeLocks = (
  current: VideohubSnapshot["outputLocks"],
  updates: Array<{ output: number; state: LockState }>,
) => {
  const next = new Map(current.map((lock) => [lock.output, lock.state]));
  for (const update of updates) {
    next.set(update.output, update.state);
  }

  return [...next.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([output, state]) => ({ output, state }));
};

export class DeviceSession extends EventEmitter {
  private readonly parser = new ProtocolStreamParser();
  private readonly blockFlags: SnapshotBlockFlags = {
    protocol: false,
    device: false,
    inputLabels: false,
    outputLabels: false,
    routes: false,
    locks: false,
  };

  private readonly deviceId: string;

  private socket?: net.Socket;
  private config?: DeviceConfig;
  private snapshot: VideohubSnapshot = createEmptySnapshot();
  private lastSeenAt?: string;
  private pingTimer?: NodeJS.Timeout;
  private healthTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private ackWaiter?: AckWaiter;
  private confirmationTimer?: NodeJS.Timeout;
  private retryAttempt = 0;
  private shouldReconnect = true;

  constructor(deviceId: string) {
    super();
    this.deviceId = deviceId;
  }

  getSnapshot() {
    return structuredClone(this.snapshot);
  }

  getConfig() {
    return this.config ? { ...this.config } : null;
  }

  setConfig(config: DeviceConfig | null) {
    this.config = config ?? undefined;
    this.snapshot.connection.host = config?.host;
    this.snapshot.connection.port = config?.port;
    this.snapshot.connection.error = undefined;
    this.snapshot.connection.lastEvent = config ? "config.updated" : "config.cleared";
    this.emitEvent("connection.updated");
  }

  async connect() {
    if (!this.config) {
      this.setConnectionState("error", "No device configured.");
      return;
    }

    this.clearReconnectTimer();
    this.shouldReconnect = true;
    this.resetSnapshotState();
    this.setConnectionState("connecting");

    await this.openSocket();
  }

  async disconnect() {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.clearTimers();
    this.rejectAckWaiter(new Error("Disconnected."));

    if (this.socket) {
      const socket = this.socket;
      this.socket = undefined;
      socket.removeAllListeners();
      socket.destroy();
    }

    this.snapshot.pendingRoute = undefined;
    this.snapshot.connection.ready = false;
    this.setConnectionState("disconnected");
  }

  async refresh() {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("Device is not connected.");
    }

    const requests = [
      PROTOCOL_HEADERS.inputLabels,
      PROTOCOL_HEADERS.outputLabels,
      PROTOCOL_HEADERS.videoOutputRouting,
      PROTOCOL_HEADERS.videoOutputLocks,
    ];
    for (const header of requests) {
      this.sendRaw(serializeStatusDumpRequest(header));
    }
  }

  async route(output: number, input: number) {
    if (!this.config || !this.socket || this.socket.destroyed) {
      throw new Error("Device is not connected.");
    }

    if (this.snapshot.pendingRoute) {
      throw new Error("A route change is already pending.");
    }

    if (this.snapshot.device.devicePresent !== true) {
      throw new Error("The connected device is not ready for routing.");
    }

    if (
      typeof this.snapshot.device.videoOutputs === "number" &&
      (output < 0 || output >= this.snapshot.device.videoOutputs)
    ) {
      throw new Error("Output index is out of range.");
    }

    if (
      typeof this.snapshot.device.videoInputs === "number" &&
      (input < 0 || input >= this.snapshot.device.videoInputs)
    ) {
      throw new Error("Input index is out of range.");
    }

    const outputLock = this.snapshot.outputLocks.find((entry) => entry.output === output);
    if (outputLock?.state === "L") {
      throw new Error("That output is locked by another client.");
    }

    const currentRoute = this.snapshot.routes.find((entry) => entry.output === output);
    if (currentRoute?.input === input) {
      return this.getSnapshot();
    }

    const pendingRoute: PendingRoute = {
      output,
      input,
      requestedAt: new Date().toISOString(),
      status: "awaiting_ack",
    };
    this.snapshot.pendingRoute = pendingRoute;
    this.emitEvent("route.pending", { output, input, status: pendingRoute.status });

    this.sendRaw(serializeVideoOutputRoute(output, input));

    await this.awaitAck();

    if (!this.snapshot.pendingRoute) {
      return this.getSnapshot();
    }

    this.snapshot.pendingRoute = {
      ...this.snapshot.pendingRoute,
      status: "awaiting_confirmation",
    };
    this.emitEvent("route.pending", { output, input, status: "awaiting_confirmation" });
    this.requestRouteDumpSoon();

    this.confirmationTimer = setTimeout(() => {
      if (
        this.snapshot.pendingRoute &&
        this.snapshot.pendingRoute.output === output &&
        this.snapshot.pendingRoute.input === input
      ) {
        this.snapshot.pendingRoute = {
          ...this.snapshot.pendingRoute,
          status: "ambiguous",
        };
        this.emitEvent("route.failed", {
          output,
          input,
          reason: "timeout_waiting_for_authoritative_update",
        });
        void this.refresh().catch((error: unknown) => {
          this.emitEvent("protocol.error", {
            message: error instanceof Error ? error.message : "Failed to refresh routes.",
          });
        });
      }
    }, ROUTE_CONFIRMATION_TIMEOUT_MS);

    return this.getSnapshot();
  }

  private async openSocket() {
    if (!this.config) {
      return;
    }

    const socket = net.createConnection({
      host: this.config.host,
      port: this.config.port,
    });
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const handleConnect = () => {
        socket.removeListener("error", handleError);
        this.retryAttempt = 0;
        this.lastSeenAt = new Date().toISOString();
        this.startTimers();
        this.setConnectionState("connected");
        resolve();
      };

      const handleError = (error: Error) => {
        socket.removeListener("connect", handleConnect);
        reject(error);
      };

      socket.once("connect", handleConnect);
      socket.once("error", handleError);

      socket.on("data", (chunk) => {
        this.lastSeenAt = new Date().toISOString();
        this.snapshot.connection.lastSeenAt = this.lastSeenAt;
        for (const block of this.parser.push(chunk)) {
          this.handleBlock(block);
        }
      });

      socket.on("error", (error) => {
        this.handleSocketError(error);
      });

      socket.on("close", () => {
        this.handleSocketClose();
      });
    }).catch((error) => {
      this.handleSocketError(error as Error);
    });
  }

  private handleBlock(block: ParsedProtocolBlock) {
    this.snapshot.connection.lastEvent = block.header;
    this.snapshot.connection.lastSeenAt = this.lastSeenAt;

    switch (block.kind) {
      case "protocol-preamble":
        this.blockFlags.protocol = true;
        this.snapshot.device.protocolVersion = block.payload.version;
        this.emitEvent("connection.updated", { protocolVersion: block.payload.version });
        break;
      case "videohub-device":
        this.blockFlags.device = true;
        this.snapshot.device = {
          ...this.snapshot.device,
          ...block.payload,
          protocolVersion: this.snapshot.device.protocolVersion,
        };
        this.emitEvent("device.updated", block.payload);
        break;
      case "input-labels":
        this.blockFlags.inputLabels = true;
        this.snapshot.inputs = mergeLabels(this.snapshot.inputs, block.payload);
        this.emitEvent("labels.updated", { kind: block.kind, count: block.payload.length });
        break;
      case "output-labels":
        this.blockFlags.outputLabels = true;
        this.snapshot.outputs = mergeLabels(this.snapshot.outputs, block.payload);
        this.emitEvent("labels.updated", { kind: block.kind, count: block.payload.length });
        break;
      case "video-output-routing":
        this.blockFlags.routes = true;
        this.snapshot.routes = mergeRoutes(this.snapshot.routes, block.payload);
        this.maybeResolvePendingRoute(block.payload);
        this.emitEvent("routes.updated", { count: block.payload.length });
        break;
      case "video-output-locks":
        this.blockFlags.locks = true;
        this.snapshot.outputLocks = mergeLocks(this.snapshot.outputLocks, block.payload);
        this.emitEvent("locks.updated", { count: block.payload.length });
        break;
      case "ack":
        this.resolveAckWaiter();
        break;
      case "nak":
        this.failPendingRoute("nak");
        this.rejectAckWaiter(new Error("The Videohub server rejected the request."));
        break;
      case "unknown":
      case "ping":
        break;
    }

    this.updateReadyState();
  }

  private maybeResolvePendingRoute(updates: RoutePoint[]) {
    if (!this.snapshot.pendingRoute) {
      return;
    }

    const matchingRoute = updates.find(
      (route) => route.output === this.snapshot.pendingRoute?.output,
    );
    if (!matchingRoute) {
      return;
    }

    const pendingRoute = this.snapshot.pendingRoute;
    this.snapshot.pendingRoute = undefined;
    this.clearConfirmationTimer();
    this.emitEvent("route.resolved", {
      output: matchingRoute.output,
      input: matchingRoute.input,
      matchedRequestedInput: matchingRoute.input === pendingRoute.input,
    });
  }

  private requestRouteDumpSoon() {
    setTimeout(() => {
      if (!this.snapshot.pendingRoute) {
        return;
      }

      try {
        this.sendRaw(serializeStatusDumpRequest(PROTOCOL_HEADERS.videoOutputRouting));
      } catch (error) {
        this.emitEvent("protocol.error", {
          message: error instanceof Error ? error.message : "Failed to request route status dump.",
        });
      }
    }, ROUTE_DUMP_REQUEST_DELAY_MS);
  }

  private async awaitAck() {
    if (this.ackWaiter) {
      throw new Error("A protocol acknowledgement is already pending.");
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ackWaiter = undefined;
        this.failPendingRoute("ack_timeout");
        reject(new Error("Timed out waiting for Videohub acknowledgement."));
      }, ACK_TIMEOUT_MS);
      this.ackWaiter = { resolve, reject, timer };
    });
  }

  private resolveAckWaiter() {
    if (!this.ackWaiter) {
      return;
    }

    clearTimeout(this.ackWaiter.timer);
    this.ackWaiter.resolve();
    this.ackWaiter = undefined;
  }

  private rejectAckWaiter(error: Error) {
    if (!this.ackWaiter) {
      return;
    }

    clearTimeout(this.ackWaiter.timer);
    this.ackWaiter.reject(error);
    this.ackWaiter = undefined;
  }

  private failPendingRoute(reason: string) {
    if (!this.snapshot.pendingRoute) {
      return;
    }

    const pendingRoute = this.snapshot.pendingRoute;
    this.snapshot.pendingRoute = undefined;
    this.clearConfirmationTimer();
    this.emitEvent("route.failed", {
      output: pendingRoute.output,
      input: pendingRoute.input,
      reason,
    });
  }

  private updateReadyState() {
    const devicePresent = this.snapshot.device.devicePresent;
    const requiredBlocksReceived =
      this.blockFlags.protocol &&
      this.blockFlags.device &&
      (devicePresent !== true ||
        (this.blockFlags.inputLabels &&
          this.blockFlags.outputLabels &&
          this.blockFlags.routes &&
          this.blockFlags.locks));

    this.snapshot.connection.ready =
      this.snapshot.connection.state === "connected" &&
      requiredBlocksReceived &&
      devicePresent === true;
  }

  private setConnectionState(
    state: VideohubSnapshot["connection"]["state"],
    error?: string,
  ) {
    this.snapshot.connection.state = state;
    this.snapshot.connection.error = error;
    this.updateReadyState();
    this.emitEvent("connection.updated", {
      state,
      ...(error ? { error } : {}),
    });
  }

  private startTimers() {
    this.clearTimers();
    this.pingTimer = setInterval(() => {
      if (this.socket && !this.socket.destroyed) {
        this.sendRaw(serializePing());
      }
    }, PING_INTERVAL_MS);

    this.healthTimer = setInterval(() => {
      if (!this.lastSeenAt) {
        return;
      }

      const elapsed = Date.now() - Date.parse(this.lastSeenAt);
      if (elapsed > DEGRADED_THRESHOLD_MS && this.snapshot.connection.state === "connected") {
        this.setConnectionState("degraded", "No response from Videohub server within 30 seconds.");
      }
    }, 1000);
  }

  private clearTimers() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }

    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }

    this.clearConfirmationTimer();
  }

  private clearConfirmationTimer() {
    if (this.confirmationTimer) {
      clearTimeout(this.confirmationTimer);
      this.confirmationTimer = undefined;
    }
  }

  private handleSocketError(error: Error) {
    this.rejectAckWaiter(error);
    this.clearTimers();
    this.socket = undefined;
    this.snapshot.connection.ready = false;
    this.setConnectionState("error", error.message);
    this.scheduleReconnect();
  }

  private handleSocketClose() {
    this.clearTimers();
    this.socket = undefined;
    this.snapshot.connection.ready = false;
    this.setConnectionState("disconnected");
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (!this.shouldReconnect || !this.config || this.reconnectTimer) {
      return;
    }

    const delay = RETRY_DELAYS_MS[Math.min(this.retryAttempt, RETRY_DELAYS_MS.length - 1)] ?? 30000;
    this.retryAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private resetSnapshotState() {
    this.snapshot = {
      ...createEmptySnapshot(),
      connection: {
        ...createEmptySnapshot().connection,
        host: this.config?.host,
        port: this.config?.port,
      },
    };
    this.blockFlags.protocol = false;
    this.blockFlags.device = false;
    this.blockFlags.inputLabels = false;
    this.blockFlags.outputLabels = false;
    this.blockFlags.routes = false;
    this.blockFlags.locks = false;
  }

  private sendRaw(payload: string) {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("Device is not connected.");
    }

    this.socket.write(payload);
  }

  private emitEvent<TPayload>(type: ProtocolEventType, payload?: TPayload) {
    const event: ServerEvent<TPayload> = {
      type,
      snapshot: this.getSnapshot(),
      ...(payload ? { payload } : {}),
      emittedAt: new Date().toISOString(),
    };
    this.emit("event", event);
  }
}
