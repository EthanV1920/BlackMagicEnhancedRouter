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
  private readonly inputLabels = ["Camera 1", "Camera 2"];
  private readonly outputLabels = ["Program", "Multiview"];
  private routes = [0, 1];
  private locks: Array<"U" | "L" | "O"> = ["U", "U"];
  private routeBehavior: "ack" | "nak" = "ack";
  port = 0;
  devicePresent: "true" | "false" | "needs_update" = "true";

  async start() {
    this.server.on("connection", (socket) => {
      this.socket = socket;
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
  let mockServer: MockVideohubServer;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "videohub-router-"));
    mockServer = new MockVideohubServer();
    await mockServer.start();
  });

  afterEach(async () => {
    await mockServer.stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("connects to a configured Videohub and exposes the normalized snapshot", async () => {
    const { app } = await buildApp({
      configPath: path.join(tempDir, "device.json"),
      staticRoot: path.join(tempDir, "missing-dist"),
    });

    await app.inject({
      method: "PUT",
      url: "/api/device/config",
      payload: {
        host: "127.0.0.1",
        port: mockServer.port,
        name: "Test Router",
      },
    });

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

  it("keeps route state authoritative after ACK and update", async () => {
    const { app } = await buildApp({
      configPath: path.join(tempDir, "device.json"),
      staticRoot: path.join(tempDir, "missing-dist"),
    });

    await app.inject({
      method: "PUT",
      url: "/api/device/config",
      payload: {
        host: "127.0.0.1",
        port: mockServer.port,
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

  it("returns errors for rejected or locked route changes", async () => {
    const { app } = await buildApp({
      configPath: path.join(tempDir, "device.json"),
      staticRoot: path.join(tempDir, "missing-dist"),
    });

    mockServer.setLocks(["L", "U"]);
    await app.inject({
      method: "PUT",
      url: "/api/device/config",
      payload: {
        host: "127.0.0.1",
        port: mockServer.port,
      },
    });

    await delay(50);

    const lockedResponse = await app.inject({
      method: "POST",
      url: "/api/routes",
      payload: { output: 0, input: 1 },
    });
    expect(lockedResponse.statusCode).toBe(423);

    mockServer.setLocks(["U", "U"]);
    mockServer.setRouteBehavior("nak");
    const nakResponse = await app.inject({
      method: "POST",
      url: "/api/routes",
      payload: { output: 1, input: 0 },
    });
    expect(nakResponse.statusCode).toBe(400);

    await app.close();
  });
});
