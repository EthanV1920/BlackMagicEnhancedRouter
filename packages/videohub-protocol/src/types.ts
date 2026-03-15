import type { LockState } from "@blackmagic-enhanced-router/shared";

export const PROTOCOL_HEADERS = {
  protocolPreamble: "PROTOCOL PREAMBLE",
  device: "VIDEOHUB DEVICE",
  inputLabels: "INPUT LABELS",
  outputLabels: "OUTPUT LABELS",
  videoOutputRouting: "VIDEO OUTPUT ROUTING",
  videoOutputLocks: "VIDEO OUTPUT LOCKS",
  ack: "ACK",
  nak: "NAK",
  ping: "PING",
} as const;

export type SupportedProtocolHeader =
  (typeof PROTOCOL_HEADERS)[keyof typeof PROTOCOL_HEADERS];

export type ProtocolBlockBase = {
  header: string;
  rawLines: string[];
  rawText: string;
};

export type ProtocolPreambleBlock = ProtocolBlockBase & {
  kind: "protocol-preamble";
  payload: {
    version: string;
  };
};

export type VideohubDeviceBlock = ProtocolBlockBase & {
  kind: "videohub-device";
  payload: {
    devicePresent: boolean | "needs_update";
    modelName?: string;
    videoInputs?: number;
    videoOutputs?: number;
  };
};

export type LabelsBlock = ProtocolBlockBase & {
  kind: "input-labels" | "output-labels";
  payload: Array<{ index: number; name: string }>;
};

export type RoutesBlock = ProtocolBlockBase & {
  kind: "video-output-routing";
  payload: Array<{ output: number; input: number }>;
};

export type LocksBlock = ProtocolBlockBase & {
  kind: "video-output-locks";
  payload: Array<{ output: number; state: LockState }>;
};

export type AckBlock = ProtocolBlockBase & {
  kind: "ack";
};

export type NakBlock = ProtocolBlockBase & {
  kind: "nak";
};

export type PingBlock = ProtocolBlockBase & {
  kind: "ping";
};

export type UnknownBlock = ProtocolBlockBase & {
  kind: "unknown";
};

export type ParsedProtocolBlock =
  | ProtocolPreambleBlock
  | VideohubDeviceBlock
  | LabelsBlock
  | RoutesBlock
  | LocksBlock
  | AckBlock
  | NakBlock
  | PingBlock
  | UnknownBlock;

