import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import type {
  DeviceConfig,
  RouteMutationPayload,
  RouterDirectory,
  SavedRouter,
  SavedRouterPayload,
  ServerEvent,
} from "@blackmagic-enhanced-router/shared";

import { DeviceConfigStore } from "./device-config-store";
import { DeviceSession } from "./videohub-session";

const toDeviceConfig = (router: SavedRouter): DeviceConfig => ({
  host: router.host,
  port: router.port,
  ...(router.name ? { name: router.name } : {}),
});

const normalizePayload = (payload: SavedRouterPayload) => ({
  host: payload.host.trim(),
  port: payload.port ?? 9990,
  ...(payload.name?.trim() ? { name: payload.name.trim() } : {}),
});

export class DeviceSessionManager extends EventEmitter {
  private readonly store: DeviceConfigStore;
  private readonly session: DeviceSession;
  private routers: SavedRouter[] = [];
  private selectedRouterId?: string;

  constructor(store: DeviceConfigStore) {
    super();
    this.store = store;
    this.session = new DeviceSession("default");
    this.session.on("event", (event: ServerEvent) => {
      this.emit("event", {
        ...event,
        ...(this.selectedRouterId ? { selectedRouterId: this.selectedRouterId } : {}),
      });
    });
  }

  async initialize() {
    const directory = await this.store.load();
    this.routers = directory.routers;
    this.selectedRouterId = directory.selectedRouterId;

    const selectedRouter = this.getSelectedRouter();
    if (!selectedRouter && this.selectedRouterId) {
      this.selectedRouterId = undefined;
      await this.persistDirectory();
    }

    this.session.setRouterContext(selectedRouter?.id);
    this.session.setConfig(selectedRouter ? toDeviceConfig(selectedRouter) : null);

    if (selectedRouter) {
      await this.session.connect();
    }
  }

  listRouters(): RouterDirectory {
    return {
      routers: this.routers.map((router) => ({ ...router })),
      ...(this.selectedRouterId ? { selectedRouterId: this.selectedRouterId } : {}),
    };
  }

  getSelectedRouter() {
    return this.routers.find((router) => router.id === this.selectedRouterId);
  }

  getActiveSnapshot() {
    return this.session.getSnapshot();
  }

  async createRouter(payload: SavedRouterPayload) {
    const normalized = normalizePayload(payload);
    this.assertValidHost(normalized.host);
    this.assertUniqueEndpoint(normalized.host, normalized.port);

    const now = new Date().toISOString();
    const router: SavedRouter = {
      id: randomUUID(),
      host: normalized.host,
      port: normalized.port,
      ...(normalized.name ? { name: normalized.name } : {}),
      createdAt: now,
      updatedAt: now,
    };

    this.routers = [...this.routers, router];
    this.selectedRouterId = router.id;
    await this.persistDirectory();
    await this.activateSelectedRouter();
    return {
      router: { ...router },
      ...this.listRouters(),
    };
  }

  async updateRouter(routerId: string, payload: SavedRouterPayload) {
    const existingRouter = this.routers.find((router) => router.id === routerId);
    if (!existingRouter) {
      throw new Error("Router not found.");
    }

    const normalized = normalizePayload(payload);
    this.assertValidHost(normalized.host);
    this.assertUniqueEndpoint(normalized.host, normalized.port, routerId);

    const updatedRouter: SavedRouter = {
      ...existingRouter,
      host: normalized.host,
      port: normalized.port,
      name: normalized.name,
      updatedAt: new Date().toISOString(),
    };

    this.routers = this.routers.map((router) => (router.id === routerId ? updatedRouter : router));
    await this.persistDirectory();

    if (this.selectedRouterId === routerId) {
      await this.session.disconnect();
      this.session.setRouterContext(routerId);
      this.session.setConfig(toDeviceConfig(updatedRouter));
      await this.session.connect();
    }

    return {
      router: { ...updatedRouter },
      ...this.listRouters(),
    };
  }

  async deleteRouter(routerId: string) {
    const routerIndex = this.routers.findIndex((router) => router.id === routerId);
    if (routerIndex === -1) {
      throw new Error("Router not found.");
    }

    const deletingSelected = this.selectedRouterId === routerId;

    if (!deletingSelected) {
      this.routers = this.routers.filter((router) => router.id !== routerId);
      await this.persistDirectory();
      return {
        ...this.listRouters(),
        snapshot: this.getActiveSnapshot(),
      };
    }

    await this.session.disconnect();
    this.routers = this.routers.filter((router) => router.id !== routerId);

    const replacementRouter =
      this.routers[routerIndex] ??
      this.routers[Math.max(0, routerIndex - 1)];

    this.selectedRouterId = replacementRouter?.id;
    await this.persistDirectory();
    await this.activateSelectedRouter();

    return {
      ...this.listRouters(),
      snapshot: this.getActiveSnapshot(),
    };
  }

  async selectRouter(routerId: string) {
    const router = this.routers.find((entry) => entry.id === routerId);
    if (!router) {
      throw new Error("Router not found.");
    }

    if (this.selectedRouterId === routerId) {
      if (this.session.getConfig()) {
        await this.session.connect();
      } else {
        this.session.setRouterContext(routerId);
        this.session.setConfig(toDeviceConfig(router));
        await this.session.connect();
      }

      return {
        selectedRouterId: routerId,
        snapshot: this.getActiveSnapshot(),
      };
    }

    if (this.selectedRouterId) {
      await this.session.disconnect();
    }

    this.selectedRouterId = routerId;
    await this.persistDirectory();
    await this.activateSelectedRouter();

    return {
      selectedRouterId: routerId,
      snapshot: this.getActiveSnapshot(),
    };
  }

  async connectSelected() {
    const selectedRouter = this.getSelectedRouter();
    if (!selectedRouter) {
      throw new Error("No router selected.");
    }

    this.session.setRouterContext(selectedRouter.id);
    this.session.setConfig(toDeviceConfig(selectedRouter));
    await this.session.connect();
    return this.getActiveSnapshot();
  }

  async disconnectSelected() {
    await this.session.disconnect();

    const selectedRouter = this.getSelectedRouter();
    this.session.setRouterContext(selectedRouter?.id);
    this.session.setConfig(selectedRouter ? toDeviceConfig(selectedRouter) : null);
    return this.getActiveSnapshot();
  }

  async refreshSelected() {
    if (!this.getSelectedRouter()) {
      throw new Error("No router selected.");
    }

    await this.session.refresh();
    return this.getActiveSnapshot();
  }

  async routeSelected(payload: RouteMutationPayload) {
    if (!this.getSelectedRouter()) {
      throw new Error("No router selected.");
    }

    return this.session.route(payload.output, payload.input);
  }

  private async activateSelectedRouter() {
    const selectedRouter = this.getSelectedRouter();
    this.session.setRouterContext(selectedRouter?.id);
    this.session.setConfig(selectedRouter ? toDeviceConfig(selectedRouter) : null);

    if (selectedRouter) {
      await this.session.connect();
    }
  }

  private async persistDirectory() {
    const persisted = await this.store.save(this.listRouters());
    this.routers = persisted.routers;
    this.selectedRouterId = persisted.selectedRouterId;
  }

  private assertValidHost(host: string) {
    if (!host) {
      throw new Error("Host is required.");
    }
  }

  private assertUniqueEndpoint(host: string, port: number, currentRouterId?: string) {
    const existingRouter = this.routers.find(
      (router) =>
        router.id !== currentRouterId &&
        router.host === host &&
        router.port === port,
    );

    if (existingRouter) {
      throw new Error("A router with that host and port already exists.");
    }
  }
}
