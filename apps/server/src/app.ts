import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type {
  DeviceConfigPayload,
  RouteMutationPayload,
  ServerEvent,
} from "@blackmagic-enhanced-router/shared";
import fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";

import { DeviceConfigStore } from "./device-config-store";
import { DeviceSessionManager } from "./device-session-manager";

type BuildAppOptions = {
  configPath?: string;
  staticRoot?: string;
};

const dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultStaticRoot = path.resolve(dirname, "../../web/dist");

export const buildApp = async (options: BuildAppOptions = {}) => {
  const app = fastify({ logger: false });
  const configStore = new DeviceConfigStore(options.configPath);
  const sessionManager = new DeviceSessionManager(configStore);

  await sessionManager.initialize();

  app.register(fastifyWebsocket);

  app.get("/api/device/config", async () => ({
    config: sessionManager.getConfig(),
  }));

  app.put<{ Body: DeviceConfigPayload }>("/api/device/config", async (request, reply) => {
    if (!request.body.host?.trim()) {
      return reply.status(400).send({ message: "Host is required." });
    }

    const config = await sessionManager.saveConfig(request.body);
    return reply.send({ config });
  });

  app.post("/api/device/connect", async () => ({
    snapshot: await sessionManager.connect(),
  }));

  app.post("/api/device/disconnect", async () => ({
    snapshot: await sessionManager.disconnect(),
  }));

  app.get("/api/device/state", async () => ({
    snapshot: sessionManager.getSnapshot(),
  }));

  app.post("/api/device/refresh", async () => {
    const snapshot = await sessionManager.refresh();
    return { snapshot };
  });

  app.post<{ Body: RouteMutationPayload }>("/api/routes", async (request, reply) => {
    try {
      const snapshot = await sessionManager.route(request.body);
      return { snapshot };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Route request failed.";
      const statusCode =
        message === "A route change is already pending."
          ? 409
          : message.includes("locked")
            ? 423
            : 400;
      return reply.status(statusCode).send({ message });
    }
  });

  app.get(
    "/ws",
    { websocket: true },
    (socket) => {
      const send = (event: ServerEvent) => {
        socket.send(JSON.stringify(event));
      };

      send({
        type: "connection.updated",
        snapshot: sessionManager.getSnapshot(),
        emittedAt: new Date().toISOString(),
      });

      const listener = (event: ServerEvent) => {
        send(event);
      };
      sessionManager.on("event", listener);

      socket.on("close", () => {
        sessionManager.off("event", listener);
      });
    },
  );

  const staticRoot = options.staticRoot ?? defaultStaticRoot;
  if (existsSync(staticRoot)) {
    app.register(fastifyStatic, {
      root: staticRoot,
      wildcard: false,
    });

    app.get("/*", async (_request, reply) => reply.sendFile("index.html"));
  }

  return { app, sessionManager };
};
