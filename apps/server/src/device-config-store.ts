import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { DeviceConfig } from "@blackmagic-enhanced-router/shared";
import envPaths from "env-paths";

const APP_NAME = "blackmagic-enhanced-router";

export class DeviceConfigStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath =
      filePath ??
      path.join(envPaths(APP_NAME).config, "default-device.json");
  }

  async load(): Promise<DeviceConfig | null> {
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as Partial<DeviceConfig>;
      if (!parsed.host) {
        return null;
      }

      return {
        host: parsed.host,
        port: parsed.port ?? 9990,
        ...(parsed.name ? { name: parsed.name } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async save(config: DeviceConfig): Promise<DeviceConfig> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(config, null, 2), "utf8");
    return config;
  }
}

