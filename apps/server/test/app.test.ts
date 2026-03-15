import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForReadySnapshot = async (app: Awaited<ReturnType<typeof buildApp>>["app"]) => {
  const deadline = Date.now() + 2000;

  while (Date.now() < deadline) {
    const response = await app.inject({ method: "GET", url: "/api/device/state" });
    const body = response.json() as {
      snapshot: {
        connection: { ready: boolean };
      };
    };

    if (body.snapshot.connection.ready) {
      return response;
    }

    await delay(25);
  }

  throw new Error("Timed out waiting for a ready snapshot.");
};

class MockVideohubServer {
  private readonly server = net.createServer();
  private socket?: net.Socket;
  private buffer = "";
  private readonly inputLabels: [string, string];
  private readonly outputLabels: [string, string];
  private routes = [0, 1];
  private locks: Array<"U" | "L" | "O"> = ["U", "U"];
  private routeBehavior: "ack" | "nak" = "ack";
  port = 0;
  devicePresent: "true" | "false" | "needs_update" = "true";

  constructor(name: string) {
    this.inputLabels = [`${name} Cam 1`, `${name} Cam 2`];
    this.outputLabels = [`${name} Program`, `${name} Multiview`];
  }

  async start() {
    this.server.on("connection", (socket) => {
      this.socket = socket;
      socket.on("error", () => {});
      socket.write(this.initialDump());
      socket.on("data", (chunk) => {
        this.buffer += chunk.toString();
        this.flushCommands();
      });
    });

    await new Promise<void>((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        const address = this.server.address();
        if (address && typeof address === "object") {
          this.port = address.port;
        }
        resolve();
      });
    });
  }

  setRouteBehavior(behavior: "ack" | "nak") {
    this.routeBehavior = behavior;
  }

  setLocks(locks: Array<"U" | "L" | "O">) {
    this.locks = locks;
  }

  async stop() {
    this.socket?.destroy();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private flushCommands() {
    while (this.buffer.includes("\n\n")) {
      const separatorIndex = this.buffer.indexOf("\n\n");
      const rawBlock = this.buffer.slice(0, separatorIndex);
      this.buffer = this.buffer.slice(separatorIndex + 2);
      if (!rawBlock.trim()) {
        continue;
      }

      const lines = rawBlock.split("\n");
      const header = lines[0]?.replace(/:$/, "");
      const payloadLines = lines.slice(1);

      if (header === "PING") {
        this.socket?.write("ACK\n\n");
        continue;
      }

      if (header === "INPUT LABELS" && payloadLines.length === 0) {
        this.socket?.write(`ACK\n\n${this.inputLabelsBlock()}`);
        continue;
      }

      if (header === "OUTPUT LABELS" && payloadLines.length === 0) {
        this.socket?.write(`ACK\n\n${this.outputLabelsBlock()}`);
        continue;
      }

      if (header === "VIDEO OUTPUT ROUTING" && payloadLines.length === 0) {
        this.socket?.write(`ACK\n\n${this.routeBlock()}`);
        continue;
      }

      if (header === "VIDEO OUTPUT LOCKS" && payloadLines.length === 0) {
        this.socket?.write(`ACK\n\n${this.lockBlock()}`);
        continue;
      }

      if (header === "VIDEO OUTPUT ROUTING" && payloadLines.length > 0) {
        if (this.routeBehavior === "nak") {
          this.socket?.write("NAK\n\n");
          continue;
        }

        const [rawOutput, rawInput] = payloadLines[0]!.split(" ");
        if (!rawOutput || !rawInput) {
          continue;
        }

        const output = Number(rawOutput);
        const input = Number(rawInput);
        if (Number.isNaN(output) || Number.isNaN(input)) {
          continue;
        }
        this.routes[output] = input;
        this.socket?.write(`ACK\n\nVIDEO OUTPUT ROUTING:\n${output} ${input}\n\n`);
      }
    }
  }

  private initialDump() {
    const deviceBlock =
      this.devicePresent === "true"
        ? `VIDEOHUB DEVICE:
Device present: ${this.devicePresent}
Model name: Blackmagic Smart Videohub 12x12
Video inputs: 2
Video outputs: 2

`
        : `VIDEOHUB DEVICE:\nDevice present: ${this.devicePresent}\n\n`;

    return [
      "PROTOCOL PREAMBLE:\nVersion: 2.3\n\n",
      deviceBlock,
      ...(this.devicePresent === "true"
        ? [
            this.inputLabelsBlock(),
            this.outputLabelsBlock(),
            this.routeBlock(),
            this.lockBlock(),
          ]
        : []),
    ].join("");
  }

  private inputLabelsBlock() {
    return `INPUT LABELS:\n0 ${this.inputLabels[0]}\n1 ${this.inputLabels[1]}\n\n`;
  }

  private outputLabelsBlock() {
    return `OUTPUT LABELS:\n0 ${this.outputLabels[0]}\n1 ${this.outputLabels[1]}\n\n`;
  }

  private routeBlock() {
    return `VIDEO OUTPUT ROUTING:\n0 ${this.routes[0]}\n1 ${this.routes[1]}\n\n`;
  }

  private lockBlock() {
    return `VIDEO OUTPUT LOCKS:\n0 ${this.locks[0]}\n1 ${this.locks[1]}\n\n`;
  }
}

describe("Fastify app integration", () => {
  let tempDir: string;
  let routerA: MockVideohubServer;
  let routerB: MockVideohubServer;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "videohub-router-"));
    routerA = new MockVideohubServer("A");
    routerB = new MockVideohubServer("B");
    await routerA.start();
    await routerB.start();
  });

  afterEach(async () => {
    await routerA.stop();
    await routerB.stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates routers, auto-selects the latest, and exposes the normalized snapshot", async () => {
    const { app } = await buildApp({
      configPath: path.join(tempDir, "routers.json"),
      staticRoot: path.join(tempDir, "missing-dist"),
    });

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/routers",
      payload: {
        host: "127.0.0.1",
        port: routerA.port,
        name: "Router A",
      },
    });

    expect(createResponse.statusCode).toBe(200);
    const directory = createResponse.json() as {
      router: { id: string };
      routers: Array<{ id: string }>;
      selectedRouterId?: string;
    };
    expect(directory.routers).toHaveLength(1);
    expect(directory.selectedRouterId).toBe(directory.router.id);

    const response = await waitForReadySnapshot(app);
    const body = response.json() as {
      snapshot: {
        connection: { state: string; ready: boolean };
        device: { modelName?: string };
        routes: Array<{ output: number; input: number }>;
      };
    };

    expect(body.snapshot.connection.state).toBe("connected");
    expect(body.snapshot.connection.ready).toBe(true);
    expect(body.snapshot.device.modelName).toContain("Videohub");
    expect(body.snapshot.routes).toEqual([
      { output: 0, input: 0 },
      { output: 1, input: 1 },
    ]);

    await app.close();
  });

  it("switches between saved routers and emits router-aware events", async () => {
    const { app, sessionManager } = await buildApp({
      configPath: path.join(tempDir, "routers.json"),
      staticRoot: path.join(tempDir, "missing-dist"),
    });

    const seenRouterIds = new Set<string>();
    sessionManager.on("event", (event) => {
      if (event.routerId) {
        seenRouterIds.add(event.routerId);
      }
    });

    const firstCreate = await app.inject({
      method: "POST",
      url: "/api/routers",
      payload: {
        host: "127.0.0.1",
        port: routerA.port,
        name: "Router A",
      },
    });
    const firstBody = firstCreate.json() as { router: { id: string } };

    const secondCreate = await app.inject({
      method: "POST",
      url: "/api/routers",
      payload: {
        host: "127.0.0.1",
        port: routerB.port,
        name: "Router B",
      },
    });
    const secondBody = secondCreate.json() as { router: { id: string } };

    const selectResponse = await app.inject({
      method: "POST",
      url: `/api/routers/${firstBody.router.id}/select`,
    });

    expect(selectResponse.statusCode).toBe(200);
    await waitForReadySnapshot(app);

    const stateResponse = await app.inject({ method: "GET", url: "/api/device/state" });
    const body = stateResponse.json() as {
      snapshot: {
        inputs: Array<{ name: string }>;
        connection: { host?: string; port?: number };
      };
    };

    expect(body.snapshot.connection.port).toBe(routerA.port);
    expect(body.snapshot.inputs[0]?.name).toContain("A Cam");
    expect(seenRouterIds.has(firstBody.router.id)).toBe(true);
    expect(seenRouterIds.has(secondBody.router.id)).toBe(true);

    await app.close();
  });

  it("deletes the selected router and falls back to the next saved router", async () => {
    const { app } = await buildApp({
      configPath: path.join(tempDir, "routers.json"),
      staticRoot: path.join(tempDir, "missing-dist"),
    });

    const firstCreate = await app.inject({
      method: "POST",
      url: "/api/routers",
      payload: {
        host: "127.0.0.1",
        port: routerA.port,
        name: "Router A",
      },
    });
    const firstBody = firstCreate.json() as { router: { id: string } };

    const secondCreate = await app.inject({
      method: "POST",
      url: "/api/routers",
      payload: {
        host: "127.0.0.1",
        port: routerB.port,
        name: "Router B",
      },
    });
    const secondBody = secondCreate.json() as { router: { id: string } };

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/routers/${secondBody.router.id}`,
    });

    expect(deleteResponse.statusCode).toBe(200);
    const deleteBody = deleteResponse.json() as {
      routers: Array<{ id: string }>;
      selectedRouterId?: string;
      snapshot: {
        connection: { host?: string; port?: number };
      };
    };

    expect(deleteBody.routers).toHaveLength(1);
    expect(deleteBody.selectedRouterId).toBe(firstBody.router.id);
    expect(deleteBody.snapshot.connection.port).toBe(routerA.port);

    await app.close();
  });

  it("rejects duplicate endpoints and route requests when no router is selected", async () => {
    const { app } = await buildApp({
      configPath: path.join(tempDir, "routers.json"),
      staticRoot: path.join(tempDir, "missing-dist"),
    });

    const emptyRouteResponse = await app.inject({
      method: "POST",
      url: "/api/routes",
      payload: { output: 0, input: 1 },
    });
    expect(emptyRouteResponse.statusCode).toBe(400);

    const firstCreate = await app.inject({
      method: "POST",
      url: "/api/routers",
      payload: {
        host: "127.0.0.1",
        port: routerA.port,
      },
    });
    expect(firstCreate.statusCode).toBe(200);

    const duplicateCreate = await app.inject({
      method: "POST",
      url: "/api/routers",
      payload: {
        host: "127.0.0.1",
        port: routerA.port,
      },
    });
    expect(duplicateCreate.statusCode).toBe(409);

    await app.close();
  });

  it("keeps route state authoritative after ACK and update for the selected router", async () => {
    const { app } = await buildApp({
      configPath: path.join(tempDir, "routers.json"),
      staticRoot: path.join(tempDir, "missing-dist"),
    });

    await app.inject({
      method: "POST",
      url: "/api/routers",
      payload: {
        host: "127.0.0.1",
        port: routerA.port,
      },
    });

    await waitForReadySnapshot(app);

    const routeResponse = await app.inject({
      method: "POST",
      url: "/api/routes",
      payload: { output: 0, input: 1 },
    });

    expect(routeResponse.statusCode).toBe(200);
    await waitForReadySnapshot(app);

    const stateResponse = await app.inject({ method: "GET", url: "/api/device/state" });
    const body = stateResponse.json() as {
      snapshot: {
        routes: Array<{ output: number; input: number }>;
        pendingRoute?: unknown;
      };
    };

    expect(body.snapshot.routes[0]).toEqual({ output: 0, input: 1 });
    expect(body.snapshot.pendingRoute).toBeUndefined();

    await app.close();
  });

  it("returns errors for rejected or locked route changes on the selected router", async () => {
    const { app } = await buildApp({
      configPath: path.join(tempDir, "routers.json"),
      staticRoot: path.join(tempDir, "missing-dist"),
    });

    routerA.setLocks(["L", "U"]);
    await app.inject({
      method: "POST",
      url: "/api/routers",
      payload: {
        host: "127.0.0.1",
        port: routerA.port,
      },
    });

    await delay(50);

    const lockedResponse = await app.inject({
      method: "POST",
      url: "/api/routes",
      payload: { output: 0, input: 1 },
    });
    expect(lockedResponse.statusCode).toBe(423);

    routerA.setLocks(["U", "U"]);
    routerA.setRouteBehavior("nak");
    const nakResponse = await app.inject({
      method: "POST",
      url: "/api/routes",
      payload: { output: 1, input: 0 },
    });
    expect(nakResponse.statusCode).toBe(400);

    await app.close();
  });
});
