import type { LockState } from "@blackmagic-enhanced-router/shared";

import { PROTOCOL_HEADERS, type ParsedProtocolBlock } from "./types";

const lockStates = new Set<LockState>(["U", "L", "O"]);

const normalizeHeader = (line: string) => line.trim().replace(/:$/, "");

const parseIndexedTextEntries = (lines: string[]) =>
  lines.flatMap((line) => {
    const match = line.match(/^(\d+)\s+(.*)$/);
    if (!match) {
      return [];
    }

    return [{ index: Number(match[1]), name: match[2] ?? "" }];
  });

const parseKeyValue = (line: string) => {
  const separatorIndex = line.indexOf(":");
  if (separatorIndex === -1) {
    return null;
  }

  return {
    key: line.slice(0, separatorIndex).trim(),
    value: line.slice(separatorIndex + 1).trim(),
  };
};

const parseDeviceBlock = (
  header: string,
  rawLines: string[],
  rawText: string,
): ParsedProtocolBlock => {
  const payload: {
    devicePresent: boolean | "needs_update";
    modelName?: string;
    videoInputs?: number;
    videoOutputs?: number;
  } = {
    devicePresent: false,
  };

  for (const line of rawLines) {
    const pair = parseKeyValue(line);
    if (!pair) {
      continue;
    }

    switch (pair.key) {
      case "Device present":
        if (pair.value === "true") {
          payload.devicePresent = true;
        } else if (pair.value === "false") {
          payload.devicePresent = false;
        } else if (pair.value === "needs_update" || pair.value === "needs _ update") {
          payload.devicePresent = "needs_update";
        }
        break;
      case "Model name":
        payload.modelName = pair.value;
        break;
      case "Video inputs":
        payload.videoInputs = Number(pair.value);
        break;
      case "Video outputs":
        payload.videoOutputs = Number(pair.value);
        break;
      default:
        break;
    }
  }

  return {
    kind: "videohub-device",
    header,
    rawLines,
    rawText,
    payload,
  };
};

const parseRoutes = (lines: string[]) =>
  lines.flatMap((line) => {
    const match = line.match(/^(\d+)\s+(\d+)$/);
    if (!match) {
      return [];
    }

    return [{ output: Number(match[1]), input: Number(match[2]) }];
  });

const parseLocks = (lines: string[]) =>
  lines.flatMap((line) => {
    const match = line.match(/^(\d+)\s+([ULO])$/);
    if (!match) {
      return [];
    }

    const state = match[2] as LockState;
    if (!lockStates.has(state)) {
      return [];
    }

    return [{ output: Number(match[1]), state }];
  });

export const parseProtocolBlock = (lines: string[]): ParsedProtocolBlock => {
  const headerLine = lines[0]?.trim() ?? "";
  const header = normalizeHeader(headerLine);
  const rawLines = lines.slice(1);
  const rawText = `${lines.join("\n")}\n\n`;

  switch (header) {
    case PROTOCOL_HEADERS.protocolPreamble: {
      const versionLine = rawLines.find((line) => line.startsWith("Version:"));
      const version = versionLine?.split(":")[1]?.trim() ?? "unknown";
      return {
        kind: "protocol-preamble",
        header,
        rawLines,
        rawText,
        payload: { version },
      };
    }
    case PROTOCOL_HEADERS.device:
      return parseDeviceBlock(header, rawLines, rawText);
    case PROTOCOL_HEADERS.inputLabels:
      return {
        kind: "input-labels",
        header,
        rawLines,
        rawText,
        payload: parseIndexedTextEntries(rawLines),
      };
    case PROTOCOL_HEADERS.outputLabels:
      return {
        kind: "output-labels",
        header,
        rawLines,
        rawText,
        payload: parseIndexedTextEntries(rawLines),
      };
    case PROTOCOL_HEADERS.videoOutputRouting:
      return {
        kind: "video-output-routing",
        header,
        rawLines,
        rawText,
        payload: parseRoutes(rawLines),
      };
    case PROTOCOL_HEADERS.videoOutputLocks:
      return {
        kind: "video-output-locks",
        header,
        rawLines,
        rawText,
        payload: parseLocks(rawLines),
      };
    case PROTOCOL_HEADERS.ack:
      return { kind: "ack", header, rawLines, rawText };
    case PROTOCOL_HEADERS.nak:
      return { kind: "nak", header, rawLines, rawText };
    case PROTOCOL_HEADERS.ping:
      return { kind: "ping", header, rawLines, rawText };
    default:
      return { kind: "unknown", header, rawLines, rawText };
  }
};

export class ProtocolStreamParser {
  private buffer = "";
  private currentLines: string[] = [];

  push(chunk: Buffer | string): ParsedProtocolBlock[] {
    this.buffer += chunk.toString().replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const parsedBlocks: ParsedProtocolBlock[] = [];

    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line === "") {
        if (this.currentLines.length > 0) {
          parsedBlocks.push(parseProtocolBlock(this.currentLines));
          this.currentLines = [];
        }
        continue;
      }

      this.currentLines.push(line);
    }

    return parsedBlocks;
  }
}

