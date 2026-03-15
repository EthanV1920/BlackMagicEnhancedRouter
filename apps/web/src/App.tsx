import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { ServerEvent, VideohubSnapshot } from "@blackmagic-enhanced-router/shared";

import {
  connectDevice,
  createEventsSocket,
  disconnectDevice,
  fetchDeviceConfig,
  fetchDeviceState,
  type LiveUpdatesStatus,
  requestRouteChange,
  saveDeviceConfig,
} from "./api";
import { MatrixGrid } from "./components/MatrixGrid";
import { StatusBanner } from "./components/StatusBanner";

const queryClient = new QueryClient();

const blankSnapshot: VideohubSnapshot = {
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
};

const formatEventLabel = (event: ServerEvent) => {
  const time = new Date(event.emittedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return `${time} · ${event.type}`;
};

const getInitialLiveUpdatesUrl = () => {
  const configuredUrl = import.meta.env.VITE_LIVE_UPDATES_URL;
  if (configuredUrl) {
    return configuredUrl;
  }

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  if (import.meta.env.DEV) {
    return `${protocol}://${window.location.hostname}:3001/ws`;
  }

  return `${protocol}://${window.location.host}/ws`;
};

function AppShell() {
  const reactQueryClient = useQueryClient();
  const [eventLog, setEventLog] = useState<ServerEvent[]>([]);
  const [liveUpdatesOpen, setLiveUpdatesOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 1100);
  const [actionError, setActionError] = useState<string | null>(null);
  const [liveUpdatesStatus, setLiveUpdatesStatus] = useState<LiveUpdatesStatus>({
    connected: false,
    state: "connecting",
    lastChangeAt: new Date().toISOString(),
    retryAttempt: 0,
    url: getInitialLiveUpdatesUrl(),
  });
  const liveUpdatesControllerRef = useRef<ReturnType<typeof createEventsSocket> | null>(null);

  const configQuery = useQuery({
    queryKey: ["device-config"],
    queryFn: fetchDeviceConfig,
  });

  const stateQuery = useQuery({
    queryKey: ["device-state"],
    queryFn: fetchDeviceState,
    initialData: blankSnapshot,
    refetchInterval: (query) => {
      if (query.state.data?.pendingRoute) {
        return 250;
      }

      return liveUpdatesStatus.connected ? false : 1000;
    },
    refetchIntervalInBackground: true,
  });

  useEffect(() => {
    const controller = createEventsSocket(
      (event) => {
        reactQueryClient.setQueryData(["device-state"], event.snapshot);
        startTransition(() => {
          setEventLog((current) => [event, ...current].slice(0, 10));
        });
        setActionError(null);
      },
      setLiveUpdatesStatus,
    );
    liveUpdatesControllerRef.current = controller;

    return () => {
      controller.close();
      liveUpdatesControllerRef.current = null;
    };
  }, [reactQueryClient]);

  const saveConfigMutation = useMutation({
    mutationFn: saveDeviceConfig,
    onSuccess: (config) => {
      setActionError(null);
      reactQueryClient.setQueryData(["device-config"], config);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to save device config.");
    },
  });

  const connectMutation = useMutation({
    mutationFn: connectDevice,
    onSuccess: (snapshot) => {
      setActionError(null);
      reactQueryClient.setQueryData(["device-state"], snapshot);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to reconnect.");
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: disconnectDevice,
    onSuccess: (snapshot) => {
      setActionError(null);
      reactQueryClient.setQueryData(["device-state"], snapshot);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to disconnect.");
    },
  });

  const routeMutation = useMutation({
    mutationFn: requestRouteChange,
    onSuccess: (snapshot) => {
      setActionError(null);
      reactQueryClient.setQueryData(["device-state"], snapshot);
      window.setTimeout(() => {
        void reactQueryClient.invalidateQueries({ queryKey: ["device-state"] });
      }, 150);
      window.setTimeout(() => {
        void reactQueryClient.invalidateQueries({ queryKey: ["device-state"] });
      }, 700);
      window.setTimeout(() => {
        void reactQueryClient.invalidateQueries({ queryKey: ["device-state"] });
      }, 1500);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to change route.");
    },
  });

  const snapshot = stateQuery.data ?? blankSnapshot;
  const isBusy =
    saveConfigMutation.isPending ||
    connectMutation.isPending ||
    disconnectMutation.isPending;

  const derivedState = useMemo(() => {
    const activeRoutes = snapshot.routes.length;
    const outputCount = snapshot.device.videoOutputs ?? snapshot.outputs.length;
    const inputCount = snapshot.device.videoInputs ?? snapshot.inputs.length;
    return { activeRoutes, outputCount, inputCount };
  }, [snapshot]);

  const liveUpdatesLabel =
    liveUpdatesStatus.state === "live"
      ? "live updates on"
      : liveUpdatesStatus.state === "retrying"
        ? "live updates retrying"
        : liveUpdatesStatus.state === "connecting"
          ? "live updates connecting"
          : "live updates off";
  const canDisconnect =
    snapshot.connection.state !== "disconnected" && snapshot.connection.state !== "error";

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar__brand">
          <span className="eyebrow">Blackmagic Videohub Matrix Router</span>
          <h1>Single-device crosspoint control</h1>
        </div>
        <div className="topbar__status">
          <span className={`badge badge--${snapshot.connection.state}`}>
            {snapshot.connection.state}
          </span>
          <button
            aria-expanded={liveUpdatesOpen}
            className={`badge badge--button ${
              liveUpdatesStatus.connected
                ? "badge--live"
                : liveUpdatesStatus.state === "retrying"
                  ? "badge--degraded"
                  : "badge--offline"
            }`}
            onClick={() => setLiveUpdatesOpen((current) => !current)}
            type="button"
          >
            {liveUpdatesLabel}
          </button>
          <button onClick={() => connectMutation.mutate()} type="button">
            Reconnect
          </button>
          <button
            disabled={!canDisconnect || disconnectMutation.isPending}
            onClick={() => disconnectMutation.mutate()}
            type="button"
          >
            Disconnect
          </button>
          <button
            aria-expanded={sidebarOpen}
            className="button-secondary"
            onClick={() => setSidebarOpen((current) => !current)}
            type="button"
          >
            {sidebarOpen ? "Hide panels" : "Show panels"}
          </button>
        </div>
      </header>

      {liveUpdatesOpen ? (
        <section className="live-updates-panel">
          <div className="live-updates-panel__header">
            <div>
              <span className="eyebrow">Live updates stream</span>
              <h2>{liveUpdatesLabel}</h2>
            </div>
            <button
              className="button-secondary"
              onClick={() => liveUpdatesControllerRef.current?.reconnect()}
              type="button"
            >
              Retry stream
            </button>
          </div>
          <dl className="live-updates-panel__details">
            <div>
              <dt>Endpoint</dt>
              <dd>{liveUpdatesStatus.url}</dd>
            </div>
            <div>
              <dt>State</dt>
              <dd>{liveUpdatesStatus.state}</dd>
            </div>
            <div>
              <dt>Last change</dt>
              <dd>{new Date(liveUpdatesStatus.lastChangeAt).toLocaleTimeString()}</dd>
            </div>
            <div>
              <dt>Retry attempt</dt>
              <dd>{liveUpdatesStatus.retryAttempt}</dd>
            </div>
            <div>
              <dt>Next retry</dt>
              <dd>
                {liveUpdatesStatus.nextRetryAt
                  ? new Date(liveUpdatesStatus.nextRetryAt).toLocaleTimeString()
                  : "None scheduled"}
              </dd>
            </div>
            <div>
              <dt>Close info</dt>
              <dd>
                {liveUpdatesStatus.closeCode
                  ? `${liveUpdatesStatus.closeCode}${
                      liveUpdatesStatus.closeReason ? ` · ${liveUpdatesStatus.closeReason}` : ""
                    }`
                  : "No close event yet"}
              </dd>
            </div>
            <div>
              <dt>Last error</dt>
              <dd>{liveUpdatesStatus.lastError ?? "No browser-side WebSocket error recorded"}</dd>
            </div>
          </dl>
        </section>
      ) : null}

      {actionError ? <div className="status-banner status-banner--error">{actionError}</div> : null}

      <StatusBanner hasConfig={Boolean(configQuery.data)} snapshot={snapshot} />

      <main className={`layout ${sidebarOpen ? "" : "layout--collapsed"}`}>
        {sidebarOpen ? (
          <aside className="sidebar">
          <section className="panel">
            <div className="panel__heading">
              <span className="eyebrow">Device target</span>
              <h2>Default Videohub</h2>
            </div>
            <form
              key={`${configQuery.data?.host ?? ""}:${configQuery.data?.port ?? 9990}:${configQuery.data?.name ?? ""}`}
              className="device-form"
              onSubmit={(event) => {
                event.preventDefault();
                const formData = new FormData(event.currentTarget);
                saveConfigMutation.mutate({
                  host: String(formData.get("host") ?? ""),
                  port: Number(String(formData.get("port") ?? "9990") || "9990"),
                  name: String(formData.get("name") ?? "") || undefined,
                });
              }}
            >
              <label>
                Host
                <input
                  defaultValue={configQuery.data?.host ?? ""}
                  name="host"
                  placeholder="192.168.1.20"
                />
              </label>
              <label>
                Port
                <input
                  defaultValue={String(configQuery.data?.port ?? 9990)}
                  inputMode="numeric"
                  name="port"
                />
              </label>
              <label>
                Friendly name
                <input
                  defaultValue={configQuery.data?.name ?? ""}
                  name="name"
                  placeholder="Rack Room Videohub"
                />
              </label>
              <button className="button-primary" disabled={saveConfigMutation.isPending} type="submit">
                Save and connect
              </button>
            </form>
          </section>

          <section className="panel">
            <div className="panel__heading">
              <span className="eyebrow">Device summary</span>
              <h2>{configQuery.data?.name ?? snapshot.device.modelName ?? "Unconfigured device"}</h2>
            </div>
            <dl className="stats-list">
              <div>
                <dt>Host</dt>
                <dd>{snapshot.connection.host ?? "Not set"}</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>{snapshot.device.modelName ?? "Unknown"}</dd>
              </div>
              <div>
                <dt>Protocol</dt>
                <dd>{snapshot.device.protocolVersion}</dd>
              </div>
              <div>
                <dt>Inputs</dt>
                <dd>{derivedState.inputCount}</dd>
              </div>
              <div>
                <dt>Outputs</dt>
                <dd>{derivedState.outputCount}</dd>
              </div>
              <div>
                <dt>Routes shown</dt>
                <dd>{derivedState.activeRoutes}</dd>
              </div>
            </dl>
            <p className="legend">
              <span className="legend__item">
                <span className="lock lock--u">Unlocked</span>
              </span>
              <span className="legend__item">
                <span className="lock lock--o">Owned lock</span>
              </span>
              <span className="legend__item">
                <span className="lock lock--l">Remote lock</span>
              </span>
            </p>
          </section>

          <section className="panel">
            <div className="panel__heading">
              <span className="eyebrow">Protocol activity</span>
              <h2>Event log</h2>
            </div>
            <ul className="event-log">
              {eventLog.length === 0 ? (
                <li>No protocol events received yet.</li>
              ) : (
                eventLog.map((event, index) => (
                  <li key={`${event.emittedAt}-${index}`}>
                    <strong>{formatEventLabel(event)}</strong>
                    <span>{JSON.stringify(event.payload ?? {})}</span>
                  </li>
                ))
              )}
            </ul>
          </section>
          </aside>
        ) : null}

        <section className="matrix-panel">
          <div className="compact-strip" aria-label="Tablet summary">
            <span className="compact-pill">
              <strong>{snapshot.device.modelName ?? configQuery.data?.name ?? "Videohub"}</strong>
              <small>{snapshot.connection.host ?? "No host"}</small>
            </span>
            <span className="compact-pill">
              <strong>{derivedState.outputCount}x{derivedState.inputCount}</strong>
              <small>{derivedState.activeRoutes} routes shown</small>
            </span>
            <span className={`compact-pill compact-pill--${snapshot.connection.state}`}>
              <strong>{snapshot.connection.state}</strong>
              <small>{liveUpdatesLabel}</small>
            </span>
          </div>
          <div className="panel panel--matrix">
            <div className="panel__heading">
              <span className="eyebrow">Route matrix</span>
              <h2>Outputs vs. inputs</h2>
            </div>
            <MatrixGrid
              disabled={
                isBusy ||
                snapshot.connection.state !== "connected" ||
                snapshot.device.devicePresent !== true
              }
              onRoute={(output, input) => routeMutation.mutate({ output, input })}
              snapshot={snapshot}
            />
          </div>
        </section>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppShell />
    </QueryClientProvider>
  );
}
