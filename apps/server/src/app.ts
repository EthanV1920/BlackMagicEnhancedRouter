import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type {
  RouteMutationPayload,
  SavedRouterPayload,
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

  await app.register(fastifyWebsocket);

  app.get("/api/routers", async () => ({
    ...sessionManager.listRouters(),
  }));

  app.post<{ Body: SavedRouterPayload }>("/api/routers", async (request, reply) => {
    if (!request.body.host?.trim()) {
      return reply.status(400).send({ message: "Host is required." });
    }

    try {
      const result = await sessionManager.createRouter(request.body);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create router.";
      const statusCode = message.includes("already exists") ? 409 : 400;
      return reply.status(statusCode).send({ message });
    }
  });

  app.put<{ Body: SavedRouterPayload; Params: { routerId: string } }>(
    "/api/routers/:routerId",
    async (request, reply) => {
      if (!request.body.host?.trim()) {
        return reply.status(400).send({ message: "Host is required." });
      }

      try {
        const result = await sessionManager.updateRouter(request.params.routerId, request.body);
        return reply.send(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to update router.";
        const statusCode =
          message === "Router not found."
            ? 404
            : message.includes("already exists")
              ? 409
              : 400;
        return reply.status(statusCode).send({ message });
      }
    },
  );

  app.delete<{ Params: { routerId: string } }>("/api/routers/:routerId", async (request, reply) => {
    try {
      const result = await sessionManager.deleteRouter(request.params.routerId);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to delete router.";
      const statusCode = message === "Router not found." ? 404 : 400;
      return reply.status(statusCode).send({ message });
    }
  });

  app.post<{ Params: { routerId: string } }>("/api/routers/:routerId/select", async (request, reply) => {
    try {
      return reply.send(await sessionManager.selectRouter(request.params.routerId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to select router.";
      const statusCode = message === "Router not found." ? 404 : 400;
      return reply.status(statusCode).send({ message });
    }
  });

  app.post("/api/device/connect", async (_request, reply) => {
    try {
      return reply.send({
        snapshot: await sessionManager.connectSelected(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to connect.";
      return reply.status(400).send({ message });
    }
  });

  app.post("/api/device/disconnect", async () => ({
    snapshot: await sessionManager.disconnectSelected(),
  }));

  app.get("/api/device/state", async () => ({
    snapshot: sessionManager.getActiveSnapshot(),
  }));

  app.post("/api/device/refresh", async (_request, reply) => {
    try {
      const snapshot = await sessionManager.refreshSelected();
      return { snapshot };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to refresh.";
      return reply.status(400).send({ message });
    }
  });

  app.post<{ Body: RouteMutationPayload }>("/api/routes", async (request, reply) => {
    try {
      const snapshot = await sessionManager.routeSelected(request.body);
      return { snapshot };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Route request failed.";
      const statusCode =
        message === "A route change is already pending."
          ? 409
          : message.includes("locked")
            ? 423
            : message === "No router selected."
              ? 400
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
        snapshot: sessionManager.getActiveSnapshot(),
        emittedAt: new Date().toISOString(),
        ...(sessionManager.getSelectedRouter()?.id
          ? { routerId: sessionManager.getSelectedRouter()?.id, selectedRouterId: sessionManager.getSelectedRouter()?.id }
          : {}),
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
