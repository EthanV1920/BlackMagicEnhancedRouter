export type DeviceConfig = {
  host: string;
  port: number;
  name?: string;
};

export type SavedRouter = {
  id: string;
  host: string;
  port: number;
  name?: string;
  createdAt: string;
  updatedAt: string;
};

export type SavedRouterPayload = {
  host: string;
  port?: number;
  name?: string;
};

export type RouterSelection = {
  selectedRouterId?: string;
};

export type RouterDirectory = {
  routers: SavedRouter[];
  selectedRouterId?: string;
};

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "degraded"
  | "error";

export type LockState = "U" | "L" | "O";

export type DevicePresentState = boolean | "needs_update";

export type VideohubDeviceInfo = {
  protocolVersion: string;
  devicePresent: DevicePresentState;
  modelName?: string;
  videoInputs?: number;
  videoOutputs?: number;
};

export type PortLabel = {
  index: number;
  name: string;
};

export type RoutePoint = {
  output: number;
  input: number;
};

export type OutputLock = {
  output: number;
  state: LockState;
};

export type PendingRoute = {
  output: number;
  input: number;
  requestedAt: string;
  status: "awaiting_ack" | "awaiting_confirmation" | "ambiguous";
};

export type VideohubSnapshot = {
  connection: {
    state: ConnectionState;
    ready: boolean;
    lastSeenAt?: string;
    host?: string;
    port?: number;
    error?: string;
    lastEvent?: string;
  };
  device: VideohubDeviceInfo;
  inputs: PortLabel[];
  outputs: PortLabel[];
  routes: RoutePoint[];
  outputLocks: OutputLock[];
  pendingRoute?: PendingRoute;
};

export type ProtocolEventType =
  | "connection.updated"
  | "device.updated"
  | "labels.updated"
  | "routes.updated"
  | "locks.updated"
  | "route.pending"
  | "route.failed"
  | "route.resolved"
  | "protocol.error";

export type ServerEvent<TPayload = unknown> = {
  type: ProtocolEventType;
  snapshot: VideohubSnapshot;
  payload?: TPayload;
  emittedAt: string;
  routerId?: string;
  selectedRouterId?: string;
};

export type RouteMutationPayload = {
  output: number;
  input: number;
};
