import type {
  DeviceConfig,
  DeviceConfigPayload,
  RouteMutationPayload,
  ServerEvent,
  VideohubSnapshot,
} from "@blackmagic-enhanced-router/shared";

type JsonRequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
};

export type LiveUpdatesStatus = {
  connected: boolean;
  state: "connecting" | "live" | "retrying" | "closed";
  lastChangeAt: string;
  lastError?: string;
  closeCode?: number;
  closeReason?: string;
  retryAttempt: number;
  nextRetryAt?: string;
  url: string;
};

const getLiveUpdatesUrl = () => {
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

const jsonRequest = async <T>(input: RequestInfo, init?: JsonRequestOptions) => {
  const { body, ...requestInit } = init ?? {};
  const headers = new Headers(requestInit.headers ?? undefined);

  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }

  if (body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(input, {
    ...requestInit,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? "Request failed.");
  }

  return (await response.json()) as T;
};

export const fetchDeviceConfig = async () => {
  const response = await jsonRequest<{ config: DeviceConfig | null }>("/api/device/config");
  return response.config;
};

export const saveDeviceConfig = async (payload: DeviceConfigPayload) => {
  const response = await jsonRequest<{ config: DeviceConfig }>("/api/device/config", {
    method: "PUT",
    body: payload,
  });
  return response.config;
};

export const fetchDeviceState = async () => {
  const response = await jsonRequest<{ snapshot: VideohubSnapshot }>("/api/device/state");
  return response.snapshot;
};

export const connectDevice = async () => {
  const response = await jsonRequest<{ snapshot: VideohubSnapshot }>("/api/device/connect", {
    method: "POST",
  });
  return response.snapshot;
};

export const disconnectDevice = async () => {
  const response = await jsonRequest<{ snapshot: VideohubSnapshot }>("/api/device/disconnect", {
    method: "POST",
  });
  return response.snapshot;
};

export const refreshDeviceState = async () => {
  const response = await jsonRequest<{ snapshot: VideohubSnapshot }>("/api/device/refresh", {
    method: "POST",
  });
  return response.snapshot;
};

export const requestRouteChange = async (payload: RouteMutationPayload) => {
  const response = await jsonRequest<{ snapshot: VideohubSnapshot }>("/api/routes", {
    method: "POST",
    body: payload,
  });
  return response.snapshot;
};

export const createEventsSocket = (
  onEvent: (event: ServerEvent) => void,
  onStatusChange: (status: LiveUpdatesStatus) => void,
) => {
  const url = getLiveUpdatesUrl();
  let socket: WebSocket | null = null;
  let manualClose = false;
  let retryAttempt = 0;
  let reconnectTimer: number | undefined;
  let currentStatus: LiveUpdatesStatus = {
    connected: false,
    state: "connecting",
    lastChangeAt: new Date().toISOString(),
    retryAttempt: 0,
    url,
  };

  const publishStatus = (partial: Partial<LiveUpdatesStatus>) => {
    currentStatus = {
      ...currentStatus,
      ...partial,
      url,
      lastChangeAt: partial.lastChangeAt ?? new Date().toISOString(),
    };
    onStatusChange(currentStatus);
  };

  const clearReconnect = () => {
    if (reconnectTimer !== undefined) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  };

  const connect = () => {
    clearReconnect();
    publishStatus({
      connected: false,
      state: retryAttempt === 0 ? "connecting" : "retrying",
      retryAttempt,
      nextRetryAt: undefined,
    });

    socket = new WebSocket(url);

    socket.addEventListener("open", () => {
      retryAttempt = 0;
      publishStatus({
        connected: true,
        state: "live",
        retryAttempt: 0,
        lastError: undefined,
        closeCode: undefined,
        closeReason: undefined,
        nextRetryAt: undefined,
      });
    });

    socket.addEventListener("message", (message) => {
      try {
        onEvent(JSON.parse(message.data) as ServerEvent);
      } catch (error) {
        publishStatus({
          lastError: error instanceof Error ? error.message : "Failed to parse WebSocket event.",
        });
      }
    });

    socket.addEventListener("error", () => {
      publishStatus({
        connected: false,
        lastError: "The browser could not establish the live updates stream.",
      });
    });

    socket.addEventListener("close", (event) => {
      socket = null;
      if (manualClose) {
        publishStatus({
          connected: false,
          state: "closed",
          closeCode: event.code,
          closeReason: event.reason || undefined,
          nextRetryAt: undefined,
        });
        return;
      }

      const delayMs = Math.min(1000 * 2 ** retryAttempt, 10000);
      retryAttempt += 1;
      publishStatus({
        connected: false,
        state: "retrying",
        retryAttempt,
        closeCode: event.code,
        closeReason: event.reason || undefined,
        nextRetryAt: new Date(Date.now() + delayMs).toISOString(),
      });
      reconnectTimer = window.setTimeout(connect, delayMs);
    });
  };

  connect();

  return {
    close: () => {
      manualClose = true;
      clearReconnect();
      socket?.close();
    },
    reconnect: () => {
      manualClose = true;
      clearReconnect();
      socket?.close();
      manualClose = false;
      retryAttempt = 0;
      connect();
    },
  };
};
