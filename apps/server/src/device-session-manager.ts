import { EventEmitter } from "node:events";

import type {
  DeviceConfig,
  DeviceConfigPayload,
  RouteMutationPayload,
  ServerEvent,
} from "@blackmagic-enhanced-router/shared";

import { DeviceConfigStore } from "./device-config-store";
import { DeviceSession } from "./videohub-session";

const normalizeConfig = (payload: DeviceConfigPayload): DeviceConfig => ({
  host: payload.host.trim(),
  port: payload.port ?? 9990,
  ...(payload.name?.trim() ? { name: payload.name.trim() } : {}),
});

export class DeviceSessionManager extends EventEmitter {
  private readonly store: DeviceConfigStore;
  private readonly session: DeviceSession;
  private config: DeviceConfig | null = null;

  constructor(store: DeviceConfigStore) {
    super();
    this.store = store;
    this.session = new DeviceSession("default");
    this.session.on("event", (event: ServerEvent) => {
      this.emit("event", event);
    });
  }

  async initialize() {
    this.config = await this.store.load();
    this.session.setConfig(this.config);
    if (this.config) {
      await this.session.connect();
    }
  }

  getConfig() {
    return this.config ? { ...this.config } : null;
  }

  getSnapshot() {
    return this.session.getSnapshot();
  }

  async saveConfig(payload: DeviceConfigPayload) {
    const normalized = normalizeConfig(payload);
    this.config = await this.store.save(normalized);
    this.session.setConfig(this.config);
    await this.session.disconnect();
    await this.session.connect();
    return this.config;
  }

  async connect() {
    await this.session.connect();
    return this.getSnapshot();
  }

  async disconnect() {
    await this.session.disconnect();
    return this.getSnapshot();
  }

  async refresh() {
    await this.session.refresh();
    return this.getSnapshot();
  }

  async route(payload: RouteMutationPayload) {
    return this.session.route(payload.output, payload.input);
  }
}

