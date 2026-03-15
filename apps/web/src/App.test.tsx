import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  readonly url: string;
  private readonly listeners = new Map<string, Set<(event?: Event) => void>>();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event?: Event) => void) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)?.add(listener);
  }

  removeEventListener(type: string, listener: (event?: Event) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  close() {
    this.emit("close", new Event("close"));
  }

  emit(type: string, event: Event) {
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
}

const createJsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });

const blankSnapshot = {
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

describe("App", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1400,
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the empty state when no routers are saved", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/routers")) {
        return createJsonResponse({ routers: [] });
      }
      if (url.endsWith("/api/device/state")) {
        return createJsonResponse({ snapshot: blankSnapshot });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(await screen.findByText(/Add or select a saved router/i)).toBeInTheDocument();
    expect(await screen.findByText(/No routers saved yet/i)).toBeInTheDocument();
  });

  it("switches routers from the top bar picker", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith("/api/routers")) {
        return createJsonResponse({
          routers: [
            {
              id: "router-a",
              host: "10.0.0.1",
              port: 9990,
              name: "Router A",
              createdAt: "2025-01-01T00:00:00.000Z",
              updatedAt: "2025-01-01T00:00:00.000Z",
            },
            {
              id: "router-b",
              host: "10.0.0.2",
              port: 9990,
              name: "Router B",
              createdAt: "2025-01-01T00:00:00.000Z",
              updatedAt: "2025-01-01T00:00:00.000Z",
            },
          ],
          selectedRouterId: "router-a",
        });
      }

      if (url.endsWith("/api/device/state")) {
        return createJsonResponse({
          snapshot: {
            ...blankSnapshot,
            connection: {
              state: "connected",
              ready: true,
              host: "10.0.0.1",
              port: 9990,
            },
            device: {
              protocolVersion: "2.3",
              devicePresent: true,
              modelName: "Blackmagic Smart Videohub",
              videoInputs: 2,
              videoOutputs: 2,
            },
          },
        });
      }

      if (url.endsWith("/api/routers/router-b/select") && init?.method === "POST") {
        return createJsonResponse({
          selectedRouterId: "router-b",
          snapshot: {
            ...blankSnapshot,
            connection: {
              state: "connecting",
              ready: false,
              host: "10.0.0.2",
              port: 9990,
            },
          },
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    const routerPicker = (await screen.findByLabelText("Selected router")) as HTMLSelectElement;
    await waitFor(() => {
      expect(routerPicker.value).toBe("router-a");
    });
    fireEvent.change(routerPicker, { target: { value: "router-b" } });

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            input === "/api/routers/router-b/select" && (init as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(true);
    });
  });
});
