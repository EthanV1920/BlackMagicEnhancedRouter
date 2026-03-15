import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { RouterDirectory, SavedRouter } from "@blackmagic-enhanced-router/shared";
import envPaths from "env-paths";

const APP_NAME = "blackmagic-enhanced-router";

type PersistedRouterDirectory = {
  routers?: SavedRouter[];
  selectedRouterId?: string;
};

type LegacyDeviceConfig = {
  host?: string;
  port?: number;
  name?: string;
};

const isLegacyConfig = (value: unknown): value is LegacyDeviceConfig =>
  typeof value === "object" &&
  value !== null &&
  "host" in value &&
  !("routers" in value);

const sanitizeRouter = (router: SavedRouter): SavedRouter => ({
  id: router.id,
  host: router.host.trim(),
  port: router.port ?? 9990,
  ...(router.name?.trim() ? { name: router.name.trim() } : {}),
  createdAt: router.createdAt,
  updatedAt: router.updatedAt,
});

export class DeviceConfigStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath =
      filePath ??
      path.join(envPaths(APP_NAME).config, "default-device.json");
  }

  async load(): Promise<RouterDirectory> {
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as PersistedRouterDirectory | LegacyDeviceConfig;

      if (isLegacyConfig(parsed)) {
        if (!parsed.host?.trim()) {
          return { routers: [] };
        }

        const now = new Date().toISOString();
        const migratedRouter: SavedRouter = {
          id: "default-router",
          host: parsed.host.trim(),
          port: parsed.port ?? 9990,
          ...(parsed.name?.trim() ? { name: parsed.name.trim() } : {}),
          createdAt: now,
          updatedAt: now,
        };

        return {
          routers: [migratedRouter],
          selectedRouterId: migratedRouter.id,
        };
      }

      const routers = (parsed.routers ?? [])
        .filter((router): router is SavedRouter => Boolean(router?.id && router?.host))
        .map(sanitizeRouter);

      const selectedRouterId = routers.some((router) => router.id === parsed.selectedRouterId)
        ? parsed.selectedRouterId
        : undefined;

      return {
        routers,
        ...(selectedRouterId ? { selectedRouterId } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { routers: [] };
      }
      throw error;
    }
  }

  async save(directory: RouterDirectory): Promise<RouterDirectory> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const normalized: RouterDirectory = {
      routers: directory.routers.map(sanitizeRouter),
      ...(directory.selectedRouterId
        ? { selectedRouterId: directory.selectedRouterId }
        : {}),
    };
    await writeFile(this.filePath, JSON.stringify(normalized, null, 2), "utf8");
    return normalized;
  }
}
