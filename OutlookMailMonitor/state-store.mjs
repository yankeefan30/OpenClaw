import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDirectory, assertPrivateFile, writePrivateJson } from "./grant.mjs";
import { FOLDER_MONITOR_ID, SENDER_MONITOR_ID } from "./definition.mjs";

const STATE_SCHEMA = "rico.outlook-mail-monitor-state";
const MAX_RECORDS_PER_STREAM = 2_000;

export class MonitorStateStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    ensurePrivateDirectory(path.dirname(this.filePath));
  }

  load() {
    if (!fs.existsSync(this.filePath)) return initialState();
    assertPrivateFile(this.filePath);
    return validateState(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
  }

  save(state) {
    const validated = validateState(state);
    writePrivateJson(this.filePath, validated);
    return validated;
  }

  record(state, streamId, record) {
    const stream = streamFor(state, streamId);
    const existing = stream.records.findIndex((item) => item.identityHash === record.identityHash);
    if (existing >= 0) stream.records[existing] = validateRecord(record);
    else stream.records.push(validateRecord(record));
    if (stream.records.length > MAX_RECORDS_PER_STREAM) {
      stream.records.splice(0, stream.records.length - MAX_RECORDS_PER_STREAM);
    }
    return this.save(state);
  }
}

export function initialState() {
  return {
    schema: STATE_SCHEMA,
    schemaVersion: 1,
    streams: {
      [FOLDER_MONITOR_ID]: initialStream(),
      [SENDER_MONITOR_ID]: initialStream(),
    },
  };
}

export function streamFor(state, streamId) {
  if (![FOLDER_MONITOR_ID, SENDER_MONITOR_ID].includes(streamId)) throw new Error("unknown monitor stream");
  return state.streams[streamId];
}

function initialStream() {
  return { initializedAt: null, cursor: null, records: [] };
}

function validateState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("monitor state must be an object");
  const keys = Object.keys(input).sort();
  if (keys.join(",") !== "schema,schemaVersion,streams" || input.schema !== STATE_SCHEMA || input.schemaVersion !== 1) {
    throw new Error("unsupported monitor state schema");
  }
  const streams = input.streams;
  if (!streams || typeof streams !== "object" || Array.isArray(streams)) throw new Error("monitor streams are invalid");
  const streamKeys = Object.keys(streams).sort();
  if (streamKeys.join(",") !== [FOLDER_MONITOR_ID, SENDER_MONITOR_ID].sort().join(",")) throw new Error("monitor streams are invalid");
  for (const streamId of [FOLDER_MONITOR_ID, SENDER_MONITOR_ID]) validateStream(streams[streamId]);
  return input;
}

function validateStream(stream) {
  if (!stream || typeof stream !== "object" || Array.isArray(stream)) throw new Error("monitor stream is invalid");
  if (Object.keys(stream).sort().join(",") !== "cursor,initializedAt,records") throw new Error("monitor stream has unexpected fields");
  if (stream.initializedAt !== null && !Number.isFinite(Date.parse(stream.initializedAt))) throw new Error("stream initializedAt is invalid");
  if (stream.cursor !== null && (typeof stream.cursor !== "string" || !stream.cursor || stream.cursor.length > 16_384)) throw new Error("stream cursor is invalid");
  if (!Array.isArray(stream.records) || stream.records.length > MAX_RECORDS_PER_STREAM) throw new Error("stream records are invalid");
  const identities = new Set();
  for (const record of stream.records) {
    validateRecord(record);
    if (identities.has(record.identityHash)) throw new Error("duplicate identity in monitor state");
    identities.add(record.identityHash);
  }
}

function validateRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("monitor record is invalid");
  if (Object.keys(record).sort().join(",") !== "at,identityHash,status") throw new Error("monitor record has unexpected fields");
  if (!/^[a-f0-9]{64}$/u.test(record.identityHash)) throw new Error("monitor record identity is invalid");
  if (!["baseline", "late-baseline", "reserved", "sent", "outcome-unknown"].includes(record.status)) throw new Error("monitor record status is invalid");
  if (!Number.isFinite(Date.parse(record.at))) throw new Error("monitor record timestamp is invalid");
  return record;
}
