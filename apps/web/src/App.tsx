import { startTransition, useEffect, useMemo, useState } from "react";
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
  refreshDeviceState,
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

function AppShell() {
  const reactQueryClient = useQueryClient();
  const [socketConnected, setSocketConnected] = useState(false);
  const [eventLog, setEventLog] = useState<ServerEvent[]>([]);

  const configQuery = useQuery({
    queryKey: ["device-config"],
    queryFn: fetchDeviceConfig,
  });

  const stateQuery = useQuery({
    queryKey: ["device-state"],
    queryFn: fetchDeviceState,
    initialData: blankSnapshot,
  });

  useEffect(() => {
    const socket = createEventsSocket(
      (event) => {
        reactQueryClient.setQueryData(["device-state"], event.snapshot);
        startTransition(() => {
          setEventLog((current) => [event, ...current].slice(0, 10));
        });
      },
      setSocketConnected,
    );

    return () => {
      socket.close();
    };
  }, [reactQueryClient]);

  const saveConfigMutation = useMutation({
    mutationFn: saveDeviceConfig,
    onSuccess: (config) => {
      reactQueryClient.setQueryData(["device-config"], config);
    },
  });

  const connectMutation = useMutation({
    mutationFn: connectDevice,
    onSuccess: (snapshot) => {
      reactQueryClient.setQueryData(["device-state"], snapshot);
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: disconnectDevice,
    onSuccess: (snapshot) => {
      reactQueryClient.setQueryData(["device-state"], snapshot);
    },
  });

  const refreshMutation = useMutation({
    mutationFn: refreshDeviceState,
    onSuccess: (snapshot) => {
      reactQueryClient.setQueryData(["device-state"], snapshot);
    },
  });

  const routeMutation = useMutation({
    mutationFn: requestRouteChange,
    onSuccess: (snapshot) => {
      reactQueryClient.setQueryData(["device-state"], snapshot);
    },
  });

  const snapshot = stateQuery.data ?? blankSnapshot;
  const isMutating =
    saveConfigMutation.isPending ||
    connectMutation.isPending ||
    disconnectMutation.isPending ||
    refreshMutation.isPending ||
    routeMutation.isPending;

  const derivedState = useMemo(() => {
    const activeRoutes = snapshot.routes.length;
    const outputCount = snapshot.device.videoOutputs ?? snapshot.outputs.length;
    const inputCount = snapshot.device.videoInputs ?? snapshot.inputs.length;
    return { activeRoutes, outputCount, inputCount };
  }, [snapshot]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <span className="eyebrow">Blackmagic Videohub Matrix Router</span>
          <h1>Single-device crosspoint control</h1>
        </div>
        <div className="topbar__status">
          <span className={`badge badge--${snapshot.connection.state}`}>
            {snapshot.connection.state}
          </span>
          <span className={`badge ${socketConnected ? "badge--live" : "badge--offline"}`}>
            {socketConnected ? "live updates on" : "live updates off"}
          </span>
          <button onClick={() => connectMutation.mutate()} type="button">
            Reconnect
          </button>
          <button onClick={() => refreshMutation.mutate()} type="button">
            Refresh
          </button>
          <button onClick={() => disconnectMutation.mutate()} type="button">
            Disconnect
          </button>
        </div>
      </header>

      <StatusBanner hasConfig={Boolean(configQuery.data)} snapshot={snapshot} />

      <main className="layout">
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

        <section className="matrix-panel">
          <div className="panel panel--matrix">
            <div className="panel__heading">
              <span className="eyebrow">Route matrix</span>
              <h2>Outputs vs. inputs</h2>
            </div>
            <MatrixGrid
              disabled={
                isMutating ||
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
