import { PROTOCOL_HEADERS } from "./types";

export const serializePing = () => `${PROTOCOL_HEADERS.ping}:\n\n`;

export const serializeVideoOutputRoute = (output: number, input: number) =>
  `${PROTOCOL_HEADERS.videoOutputRouting}:\n${output} ${input}\n\n`;

export const serializeStatusDumpRequest = (
  header:
    | typeof PROTOCOL_HEADERS.inputLabels
    | typeof PROTOCOL_HEADERS.outputLabels
    | typeof PROTOCOL_HEADERS.videoOutputRouting
    | typeof PROTOCOL_HEADERS.videoOutputLocks,
) => `${header}:\n\n`;

