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

const jsonRequest = async <T>(input: RequestInfo, init?: JsonRequestOptions) => {
  const { body, ...requestInit } = init ?? {};
  const response = await fetch(input, {
    ...requestInit,
    headers: {
      "Content-Type": "application/json",
      ...(requestInit.headers ?? {}),
    },
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
  onConnectionChange: (connected: boolean) => void,
) => {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);

  socket.addEventListener("open", () => onConnectionChange(true));
  socket.addEventListener("close", () => onConnectionChange(false));
  socket.addEventListener("message", (message) => {
    try {
      onEvent(JSON.parse(message.data) as ServerEvent);
    } catch (error) {
      console.error("Failed to parse WebSocket event.", error);
    }
  });

  return socket;
};
