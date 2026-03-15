import { startTransition, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  RouterDirectory,
  SavedRouter,
  ServerEvent,
  VideohubSnapshot,
} from "@blackmagic-enhanced-router/shared";

import {
  connectDevice,
  createEventsSocket,
  createRouter,
  deleteRouter,
  disconnectDevice,
  fetchDeviceState,
  fetchRouters,
  type LiveUpdatesStatus,
  requestRouteChange,
  selectRouter,
  updateRouter,
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

const blankRouterDirectory: RouterDirectory = {
  routers: [],
};

type RouterFormState = {
  name: string;
  host: string;
  port: string;
};

const blankRouterForm: RouterFormState = {
  name: "",
  host: "",
  port: "9990",
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

const routerLabel = (router?: Pick<SavedRouter, "name" | "host" | "port">) => {
  if (!router) {
    return "No router selected";
  }

  return router.name?.trim() || `${router.host}:${router.port}`;
};

const toRouterForm = (router?: SavedRouter): RouterFormState =>
  router
    ? {
        name: router.name ?? "",
        host: router.host,
        port: String(router.port),
      }
    : blankRouterForm;

const blankSnapshotForRouter = (router?: SavedRouter): VideohubSnapshot => ({
  ...blankSnapshot,
  connection: {
    ...blankSnapshot.connection,
    ...(router ? { host: router.host, port: router.port } : {}),
  },
});

function AppShell() {
  const reactQueryClient = useQueryClient();
  const [eventLog, setEventLog] = useState<ServerEvent[]>([]);
  const [liveUpdatesOpen, setLiveUpdatesOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 1100);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editorRouterId, setEditorRouterId] = useState<string>();
  const [isCreatingRouter, setIsCreatingRouter] = useState(false);
  const [routerForm, setRouterForm] = useState<RouterFormState>(blankRouterForm);
  const [liveUpdatesStatus, setLiveUpdatesStatus] = useState<LiveUpdatesStatus>({
    connected: false,
    state: "connecting",
    lastChangeAt: new Date().toISOString(),
    retryAttempt: 0,
    url: getInitialLiveUpdatesUrl(),
  });
  const liveUpdatesControllerRef = useRef<ReturnType<typeof createEventsSocket> | null>(null);
  const selectedRouterIdRef = useRef<string | undefined>(undefined);

  const routersQuery = useQuery({
    queryKey: ["routers"],
    queryFn: fetchRouters,
    initialData: blankRouterDirectory,
  });

  const selectedRouter = useMemo(
    () =>
      routersQuery.data.routers.find((router) => router.id === routersQuery.data.selectedRouterId),
    [routersQuery.data],
  );

  useEffect(() => {
    selectedRouterIdRef.current = selectedRouter?.id;
  }, [selectedRouter?.id]);

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
        const activeRouterId = selectedRouterIdRef.current;
        if ((event.routerId ?? undefined) !== activeRouterId) {
          return;
        }

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

  useEffect(() => {
    if (isCreatingRouter) {
      return;
    }

    const activeEditorRouter =
      routersQuery.data.routers.find((router) => router.id === editorRouterId) ?? selectedRouter;

    if (!activeEditorRouter) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRouterForm(blankRouterForm);
      return;
    }
    setRouterForm(toRouterForm(activeEditorRouter));
  }, [editorRouterId, isCreatingRouter, routersQuery.data.routers, selectedRouter]);

  const syncRouterDirectory = (directory: RouterDirectory) => {
    reactQueryClient.setQueryData(["routers"], directory);
  };

  const createRouterMutation = useMutation({
    mutationFn: createRouter,
    onSuccess: (result) => {
      const nextDirectory: RouterDirectory = {
        routers: result.routers,
        ...(result.selectedRouterId ? { selectedRouterId: result.selectedRouterId } : {}),
      };
      syncRouterDirectory(nextDirectory);
      selectedRouterIdRef.current = result.selectedRouterId;
      setIsCreatingRouter(false);
      setEditorRouterId(result.router.id);
      setRouterForm(toRouterForm(result.router));
      setEventLog([]);
      setActionError(null);
      reactQueryClient.setQueryData(["device-state"], blankSnapshotForRouter(result.router));
      void reactQueryClient.invalidateQueries({ queryKey: ["device-state"] });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to save router.");
    },
  });

  const updateRouterMutation = useMutation({
    mutationFn: ({ routerId, payload }: { routerId: string; payload: RouterFormState }) =>
      updateRouter(routerId, {
        host: payload.host,
        port: Number(payload.port || "9990"),
        name: payload.name || undefined,
      }),
    onSuccess: (result) => {
      const nextDirectory: RouterDirectory = {
        routers: result.routers,
        ...(result.selectedRouterId ? { selectedRouterId: result.selectedRouterId } : {}),
      };
      syncRouterDirectory(nextDirectory);
      setIsCreatingRouter(false);
      setEditorRouterId(result.router.id);
      setRouterForm(toRouterForm(result.router));
      setActionError(null);
      if (result.selectedRouterId === result.router.id) {
        setEventLog([]);
        reactQueryClient.setQueryData(["device-state"], blankSnapshotForRouter(result.router));
        void reactQueryClient.invalidateQueries({ queryKey: ["device-state"] });
      }
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to update router.");
    },
  });

  const deleteRouterMutation = useMutation({
    mutationFn: deleteRouter,
    onSuccess: (result) => {
      const nextDirectory: RouterDirectory = {
        routers: result.routers,
        ...(result.selectedRouterId ? { selectedRouterId: result.selectedRouterId } : {}),
      };
      syncRouterDirectory(nextDirectory);
      selectedRouterIdRef.current = result.selectedRouterId;
      setActionError(null);
      setEventLog([]);
      reactQueryClient.setQueryData(["device-state"], result.snapshot);

      if (result.selectedRouterId) {
        setIsCreatingRouter(false);
        setEditorRouterId(result.selectedRouterId);
        const fallbackRouter = result.routers.find((router) => router.id === result.selectedRouterId);
        setRouterForm(toRouterForm(fallbackRouter));
      } else {
        setIsCreatingRouter(true);
        setEditorRouterId(undefined);
        setRouterForm(blankRouterForm);
      }
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to delete router.");
    },
  });

  const selectRouterMutation = useMutation({
    mutationFn: selectRouter,
    onSuccess: (result, routerId) => {
      syncRouterDirectory({
        routers: routersQuery.data.routers,
        selectedRouterId: result.selectedRouterId,
      });
      selectedRouterIdRef.current = result.selectedRouterId;
      setIsCreatingRouter(false);
      setEditorRouterId(routerId);
      setEventLog([]);
      setActionError(null);
      reactQueryClient.setQueryData(["device-state"], result.snapshot);
      void reactQueryClient.invalidateQueries({ queryKey: ["device-state"] });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to switch routers.");
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
  const isBusy =
    createRouterMutation.isPending ||
    updateRouterMutation.isPending ||
    deleteRouterMutation.isPending ||
    selectRouterMutation.isPending ||
    connectMutation.isPending ||
    disconnectMutation.isPending;
  const hasSavedRouters = routersQuery.data.routers.length > 0;
  const activeEditorRouterId = editorRouterId ?? selectedRouter?.id;
  const editingExistingRouter = !isCreatingRouter && Boolean(activeEditorRouterId);

  const handleRouterSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (editingExistingRouter && activeEditorRouterId) {
      updateRouterMutation.mutate({
        routerId: activeEditorRouterId,
        payload: routerForm,
      });
      return;
    }

    createRouterMutation.mutate({
      host: routerForm.host,
      port: Number(routerForm.port || "9990"),
      name: routerForm.name || undefined,
    });
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar__brand">
          <span className="eyebrow">Blackmagic Videohub Matrix Router</span>
          <h1>Router control</h1>
        </div>
        <div className="topbar__status">
          <select
            aria-label="Selected router"
            className="topbar__router-picker"
            disabled={!hasSavedRouters || selectRouterMutation.isPending}
            onChange={(event) => {
              const routerId = event.target.value;
              if (!routerId) {
                return;
              }
              selectRouterMutation.mutate(routerId);
            }}
            value={routersQuery.data.selectedRouterId ?? ""}
          >
            <option value="" disabled>
              {hasSavedRouters ? "Select router" : "No routers saved"}
            </option>
            {routersQuery.data.routers.map((router) => (
              <option key={router.id} value={router.id}>
                {routerLabel(router)}
              </option>
            ))}
          </select>
          <button
            className="button-secondary"
              onClick={() => {
                setSidebarOpen(true);
                setIsCreatingRouter(true);
                setEditorRouterId(undefined);
                setRouterForm(blankRouterForm);
              }}
            type="button"
          >
            Add router
          </button>
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
          <button disabled={!selectedRouter || connectMutation.isPending} onClick={() => connectMutation.mutate()} type="button">
            Reconnect
          </button>
          <button
            disabled={!selectedRouter || !canDisconnect || disconnectMutation.isPending}
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
              <dt>Router</dt>
              <dd>{routerLabel(selectedRouter)}</dd>
            </div>
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

      <StatusBanner hasSelection={Boolean(selectedRouter)} snapshot={snapshot} />

      <main className={`layout ${sidebarOpen ? "" : "layout--collapsed"}`}>
        {sidebarOpen ? (
          <aside className="sidebar">
            <section className="panel">
              <div className="panel__heading">
                <span className="eyebrow">Saved routers</span>
                <h2>{editingExistingRouter ? "Edit router" : "Add router"}</h2>
              </div>
              <div className="saved-router-list">
                {hasSavedRouters ? (
                  routersQuery.data.routers.map((router) => (
                    <button
                      className={`saved-router-list__item ${
                        router.id === routersQuery.data.selectedRouterId
                          ? "saved-router-list__item--active"
                          : ""
                      }`}
                      key={router.id}
                      onClick={() => {
                        setIsCreatingRouter(false);
                        setEditorRouterId(router.id);
                        setRouterForm(toRouterForm(router));
                      }}
                      type="button"
                    >
                      <strong>{routerLabel(router)}</strong>
                      <small>
                        {router.host}:{router.port}
                      </small>
                    </button>
                  ))
                ) : (
                  <p className="panel__empty">No routers saved yet. Add one to start routing.</p>
                )}
              </div>
              <form className="device-form" onSubmit={handleRouterSubmit}>
                <label>
                  Friendly name
                  <input
                    name="name"
                    onChange={(event) =>
                      setRouterForm((current) => ({ ...current, name: event.target.value }))
                    }
                    placeholder="Rack Room Videohub"
                    value={routerForm.name}
                  />
                </label>
                <label>
                  Host
                  <input
                    name="host"
                    onChange={(event) =>
                      setRouterForm((current) => ({ ...current, host: event.target.value }))
                    }
                    placeholder="192.168.1.20"
                    value={routerForm.host}
                  />
                </label>
                <label>
                  Port
                  <input
                    inputMode="numeric"
                    name="port"
                    onChange={(event) =>
                      setRouterForm((current) => ({ ...current, port: event.target.value }))
                    }
                    value={routerForm.port}
                  />
                </label>
                <div className="device-form__actions">
                  <button className="button-primary" disabled={isBusy} type="submit">
                    {editingExistingRouter ? "Save router" : "Create router"}
                  </button>
                  {editingExistingRouter ? (
                    <button
                      className="button-danger"
                      disabled={deleteRouterMutation.isPending}
                      onClick={() => {
                        const router = routersQuery.data.routers.find(
                          (entry) => entry.id === activeEditorRouterId,
                        );
                        if (!router) {
                          return;
                        }
                        if (window.confirm(`Delete ${routerLabel(router)}?`)) {
                          deleteRouterMutation.mutate(router.id);
                        }
                      }}
                      type="button"
                    >
                      Delete router
                    </button>
                  ) : null}
                </div>
              </form>
            </section>

            <section className="panel">
              <div className="panel__heading">
                <span className="eyebrow">Device summary</span>
                <h2>{selectedRouter ? routerLabel(selectedRouter) : "No active router"}</h2>
              </div>
              <dl className="stats-list">
                <div>
                  <dt>Saved routers</dt>
                  <dd>{routersQuery.data.routers.length}</dd>
                </div>
                <div>
                  <dt>Host</dt>
                  <dd>{selectedRouter ? `${selectedRouter.host}:${selectedRouter.port}` : "Not set"}</dd>
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
              <strong>{selectedRouter ? routerLabel(selectedRouter) : "No active router"}</strong>
              <small>{selectedRouter ? `${selectedRouter.host}:${selectedRouter.port}` : "Add a router"}</small>
            </span>
            <span className="compact-pill">
              <strong>
                {derivedState.outputCount}x{derivedState.inputCount}
              </strong>
              <small>{derivedState.activeRoutes} routes shown</small>
            </span>
            <span className={`compact-pill compact-pill--${snapshot.connection.state}`}>
              <strong>{snapshot.connection.state}</strong>
              <small>{liveUpdatesLabel}</small>
            </span>
          </div>
          <div className="panel panel--matrix">
            <MatrixGrid
              disabled={
                isBusy ||
                !selectedRouter ||
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
