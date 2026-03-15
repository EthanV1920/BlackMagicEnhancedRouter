import { describe, expect, it } from "vitest";

import {
  PROTOCOL_HEADERS,
  ProtocolStreamParser,
  parseProtocolBlock,
  serializePing,
  serializeStatusDumpRequest,
  serializeVideoOutputRoute,
} from "../src/index";

describe("parseProtocolBlock", () => {
  it("parses protocol preamble", () => {
    const block = parseProtocolBlock(["PROTOCOL PREAMBLE:", "Version: 2.3"]);
    expect(block.kind).toBe("protocol-preamble");
    if (block.kind === "protocol-preamble") {
      expect(block.payload.version).toBe("2.3");
    }
  });

  it("parses device present states", () => {
    const trueBlock = parseProtocolBlock([
      "VIDEOHUB DEVICE:",
      "Device present: true",
      "Model name: Blackmagic Smart Videohub 12x12",
      "Video inputs: 12",
      "Video outputs: 12",
    ]);
    const falseBlock = parseProtocolBlock(["VIDEOHUB DEVICE:", "Device present: false"]);
    const needsUpdateBlock = parseProtocolBlock([
      "VIDEOHUB DEVICE:",
      "Device present: needs_update",
    ]);

    expect(trueBlock.kind).toBe("videohub-device");
    expect(falseBlock.kind).toBe("videohub-device");
    expect(needsUpdateBlock.kind).toBe("videohub-device");

    if (trueBlock.kind === "videohub-device") {
      expect(trueBlock.payload.devicePresent).toBe(true);
      expect(trueBlock.payload.videoInputs).toBe(12);
    }

    if (falseBlock.kind === "videohub-device") {
      expect(falseBlock.payload.devicePresent).toBe(false);
    }

    if (needsUpdateBlock.kind === "videohub-device") {
      expect(needsUpdateBlock.payload.devicePresent).toBe("needs_update");
    }
  });

  it("parses labels, routes, and locks", () => {
    const inputLabels = parseProtocolBlock([
      "INPUT LABELS:",
      "0 Camera 1",
      "1 Camera 2",
    ]);
    const routes = parseProtocolBlock([
      "VIDEO OUTPUT ROUTING:",
      "0 1",
      "1 0",
    ]);
    const locks = parseProtocolBlock([
      "VIDEO OUTPUT LOCKS:",
      "0 U",
      "1 L",
    ]);

    expect(inputLabels.kind).toBe("input-labels");
    expect(routes.kind).toBe("video-output-routing");
    expect(locks.kind).toBe("video-output-locks");

    if (inputLabels.kind === "input-labels") {
      expect(inputLabels.payload).toEqual([
        { index: 0, name: "Camera 1" },
        { index: 1, name: "Camera 2" },
      ]);
    }

    if (routes.kind === "video-output-routing") {
      expect(routes.payload).toEqual([
        { output: 0, input: 1 },
        { output: 1, input: 0 },
      ]);
    }

    if (locks.kind === "video-output-locks") {
      expect(locks.payload).toEqual([
        { output: 0, state: "U" },
        { output: 1, state: "L" },
      ]);
    }
  });

  it("ignores unknown blocks", () => {
    const block = parseProtocolBlock(["MYSTERY BLOCK:", "0 value"]);
    expect(block.kind).toBe("unknown");
  });
});

describe("ProtocolStreamParser", () => {
  it("handles split frames and blank-line block termination", () => {
    const parser = new ProtocolStreamParser();
    const partial = parser.push("INPUT LABELS:\n0 Camera");
    const completed = parser.push(" 1\n\nACK\n\n");

    expect(partial).toEqual([]);
    expect(completed).toHaveLength(2);
    expect(completed[0]?.kind).toBe("input-labels");
    expect(completed[1]?.kind).toBe("ack");
  });
});

describe("serializers", () => {
  it("serializes route commands and status dump requests", () => {
    expect(serializeVideoOutputRoute(7, 2)).toBe("VIDEO OUTPUT ROUTING:\n7 2\n\n");
    expect(serializePing()).toBe("PING:\n\n");
    expect(serializeStatusDumpRequest(PROTOCOL_HEADERS.outputLabels)).toBe("OUTPUT LABELS:\n\n");
  });
});
