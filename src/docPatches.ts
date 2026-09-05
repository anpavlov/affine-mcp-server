import { createHash, randomBytes } from "node:crypto";

import * as Y from "yjs";

import { diffDocStates, type DocDiff } from "./docDiff.js";

export const DOC_PATCH_TTL_MS = 30 * 60_000;
export const MAX_DOC_PATCH_RECORDS = 100;
export const MAX_DOC_PATCH_BYTES = 4 * 1024 * 1024;
export const MAX_DOC_PATCH_STORE_BYTES = 32 * 1024 * 1024;
export const MAX_DOC_PATCH_INPUT_BYTES = 4 * 1024 * 1024;
export const MAX_DOC_PATCH_RESULT_BYTES = 4 * 1024 * 1024;

export type PatchStatus = "prepared" | "applying" | "consumed" | "discarded" | "unknown" | "expired";

interface PreparedDocPatch {
  readonly patchId: string;
  readonly workspaceId: string;
  readonly docId: string;
  readonly baseSnapshotHash: string;
  readonly update: Uint8Array;
  readonly createdAt: number;
  readonly expiresAt: number;
  status: PatchStatus;
  discardReason?: "user" | "stale";
}

export interface PrepareDocPatchResult {
  patchId: string;
  workspaceId: string;
  docId: string;
  status: "prepared";
  summary: string;
  diff: DocDiff;
  expiresAt: string;
}

export class DocPatchError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DocPatchError";
  }
}

type PatchManagerDependencies = {
  loadCurrent(workspaceId: string, docId: string): Promise<Uint8Array | null>;
  pushUpdate(workspaceId: string, docId: string, update: Uint8Array): Promise<void>;
  now?: () => number;
  randomId?: () => string;
  ttlMs?: number;
  maxRecords?: number;
  maxPatchBytes?: number;
  maxStoreBytes?: number;
  maxInputBytes?: number;
  maxResultBytes?: number;
};

type PrepareOptions = {
  workspaceId: string;
  docId: string;
  input: unknown;
  mutate(proposed: Y.Doc): void;
};

function hashSnapshot(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalSnapshotHash(bytes: Uint8Array): string {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, bytes);
    return hashSnapshot(Y.encodeStateAsUpdate(doc));
  } finally {
    doc.destroy();
  }
}

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function recordBytes(record: PreparedDocPatch): number {
  return record.update.byteLength + Buffer.byteLength(
    `${record.patchId}${record.workspaceId}${record.docId}${record.baseSnapshotHash}`,
    "utf8",
  );
}

function summaryFor(diff: DocDiff): string {
  const { added, deleted, changed } = diff.stats;
  return `${added} block${added === 1 ? "" : "s"} added, ${deleted} deleted, ${changed} changed`;
}

export function createDocPatchManager(dependencies: PatchManagerDependencies) {
  const now = dependencies.now ?? Date.now;
  const randomId = dependencies.randomId ?? (() => `dp_${randomBytes(16).toString("hex")}`);
  const ttlMs = dependencies.ttlMs ?? DOC_PATCH_TTL_MS;
  const maxRecords = dependencies.maxRecords ?? MAX_DOC_PATCH_RECORDS;
  const maxPatchBytes = dependencies.maxPatchBytes ?? MAX_DOC_PATCH_BYTES;
  const maxStoreBytes = dependencies.maxStoreBytes ?? MAX_DOC_PATCH_STORE_BYTES;
  const maxInputBytes = dependencies.maxInputBytes ?? MAX_DOC_PATCH_INPUT_BYTES;
  const maxResultBytes = dependencies.maxResultBytes ?? MAX_DOC_PATCH_RESULT_BYTES;
  const records = new Map<string, PreparedDocPatch>();

  function cleanup(currentTime: number, preservePatchId?: string): void {
    for (const [patchId, record] of records) {
      if (patchId === preservePatchId || record.status === "applying") continue;
      if (currentTime >= record.expiresAt) records.delete(patchId);
    }
  }

  function addressed(patchId: string): PreparedDocPatch | undefined {
    const currentTime = now();
    const record = records.get(patchId);
    if (record && record.status === "prepared" && currentTime >= record.expiresAt) {
      record.status = "expired";
    }
    cleanup(currentTime, patchId);
    return record;
  }

  function terminalError(record: PreparedDocPatch): never {
    if (record.status === "consumed") {
      throw new DocPatchError("PATCH_CONSUMED", `Patch ${record.patchId} has already been applied.`);
    }
    if (record.status === "discarded") {
      if (record.discardReason === "stale") {
        throw new DocPatchError("PATCH_STALE", `Patch ${record.patchId} was discarded because its base document changed.`);
      }
      throw new DocPatchError("PATCH_DISCARDED", `Patch ${record.patchId} was discarded.`);
    }
    if (record.status === "unknown") {
      throw new DocPatchError(
        "PATCH_APPLY_UNKNOWN",
        `The server could not confirm whether patch ${record.patchId} was applied; read the document before preparing another patch.`,
      );
    }
    if (record.status === "expired") {
      throw new DocPatchError("PATCH_EXPIRED", `Patch ${record.patchId} has expired.`);
    }
    if (record.status === "applying") {
      throw new DocPatchError("PATCH_BUSY", `Patch ${record.patchId} is currently being applied.`);
    }
    throw new DocPatchError("PATCH_NOT_FOUND", `Patch ${record.patchId} was not found.`);
  }

  async function prepare(options: PrepareOptions): Promise<PrepareDocPatchResult> {
    cleanup(now());
    if (utf8Bytes(options.input) > maxInputBytes) {
      throw new DocPatchError("PATCH_TOO_LARGE", `Patch input exceeds ${maxInputBytes} bytes.`);
    }

    const snapshot = await dependencies.loadCurrent(options.workspaceId, options.docId);
    if (!snapshot) {
      throw new DocPatchError("PATCH_DOCUMENT_NOT_FOUND", `Document ${options.docId} was not found.`);
    }

    const base = new Y.Doc();
    const proposed = new Y.Doc();
    try {
      Y.applyUpdate(base, snapshot);
      Y.applyUpdate(proposed, Y.encodeStateAsUpdate(base));
      options.mutate(proposed);
      const diff = diffDocStates(base, proposed);
      if (diff.structural.length === 0) {
        throw new DocPatchError("PATCH_NO_CHANGES", "The requested operations do not change the document.");
      }
      const update = new Uint8Array(Y.encodeStateAsUpdate(proposed, Y.encodeStateVector(base)));
      if (update.byteLength > maxPatchBytes) {
        throw new DocPatchError("PATCH_TOO_LARGE", `Prepared update exceeds ${maxPatchBytes} bytes.`);
      }

      const createdAt = now();
      const patchId = randomId();
      if (!/^dp_[0-9a-f]{32}$/.test(patchId)) {
        throw new Error("Patch id generator returned an invalid id.");
      }
      const result: PrepareDocPatchResult = {
        patchId,
        workspaceId: options.workspaceId,
        docId: options.docId,
        status: "prepared",
        summary: summaryFor(diff),
        diff,
        expiresAt: new Date(createdAt + ttlMs).toISOString(),
      };
      if (utf8Bytes(result) > maxResultBytes) {
        throw new DocPatchError("PATCH_TOO_LARGE", `Patch review output exceeds ${maxResultBytes} bytes.`);
      }

      const record: PreparedDocPatch = {
        patchId,
        workspaceId: options.workspaceId,
        docId: options.docId,
        baseSnapshotHash: hashSnapshot(Y.encodeStateAsUpdate(base)),
        update: new Uint8Array(update),
        createdAt,
        expiresAt: createdAt + ttlMs,
        status: "prepared",
      };
      const retainedBytes = [...records.values()].reduce((total, entry) => total + recordBytes(entry), 0);
      if (records.size >= maxRecords || retainedBytes + recordBytes(record) > maxStoreBytes) {
        throw new DocPatchError("PATCH_STORE_FULL", "The session patch store is full; discard or wait for existing patches to expire.");
      }
      records.set(patchId, record);
      return result;
    } catch (error) {
      if (error instanceof DocPatchError) throw error;
      throw error;
    } finally {
      base.destroy();
      proposed.destroy();
    }
  }

  async function apply(patchId: string) {
    const record = addressed(patchId);
    if (!record) throw new DocPatchError("PATCH_NOT_FOUND", `Patch ${patchId} was not found.`);
    if (record.status !== "prepared") terminalError(record);
    record.status = "applying";
    let pushStarted = false;

    try {
      let current: Uint8Array | null;
      try {
        current = await dependencies.loadCurrent(record.workspaceId, record.docId);
      } catch (error) {
        record.status = now() >= record.expiresAt ? "expired" : "prepared";
        throw error;
      }
      if (!current || canonicalSnapshotHash(current) !== record.baseSnapshotHash) {
        record.status = "discarded";
        record.discardReason = "stale";
        throw new DocPatchError("PATCH_STALE", `Document ${record.docId} changed after this patch was prepared.`);
      }
      if (now() >= record.expiresAt) {
        record.status = "expired";
        throw new DocPatchError("PATCH_EXPIRED", `Patch ${patchId} expired before it could be sent.`);
      }

      pushStarted = true;
      try {
        await dependencies.pushUpdate(record.workspaceId, record.docId, new Uint8Array(record.update));
      } catch (error) {
        record.status = "unknown";
        throw new DocPatchError(
          "PATCH_APPLY_UNKNOWN",
          `The update was sent but no successful acknowledgement was received: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      record.status = "consumed";
      const result = {
        kind: "doc.patch.apply",
        ok: true,
        patchId: record.patchId,
        workspaceId: record.workspaceId,
        docId: record.docId,
        status: "consumed" as const,
      };
      if (now() >= record.expiresAt) records.delete(record.patchId);
      return result;
    } catch (error) {
      if (!(error instanceof DocPatchError) && !pushStarted && record.status === "applying") {
        record.status = now() >= record.expiresAt ? "expired" : "prepared";
      }
      throw error;
    }
  }

  function discard(patchId: string) {
    const record = addressed(patchId);
    if (!record) {
      return { kind: "doc.patch.discard", ok: true, patchId, status: "not_found" as const };
    }
    if (record.status === "applying") terminalError(record);
    if (record.status === "prepared") {
      record.status = "discarded";
      record.discardReason = "user";
    }
    return {
      kind: "doc.patch.discard",
      ok: true,
      patchId: record.patchId,
      workspaceId: record.workspaceId,
      docId: record.docId,
      status: record.status,
      ...(record.status === "discarded" ? { reason: record.discardReason } : {}),
    };
  }

  return { prepare, apply, discard };
}
