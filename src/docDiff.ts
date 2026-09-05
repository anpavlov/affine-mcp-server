import { createHash } from "node:crypto";

import * as Y from "yjs";

export type DiffValue =
  | null | boolean | number | string
  | { kind: "undefined" }
  | { kind: "bytes"; byteLength: number; sha256: string }
  | { kind: "text"; deltas: Array<{ insert: DiffValue; attributes?: Record<string, DiffValue> }> }
  | { kind: "map" | "object"; entries: Record<string, DiffValue> }
  | { kind: "array" | "yarray"; items: DiffValue[] };

export type FieldValue = { present: false } | { present: true; value: DiffValue };
export interface FieldChange { key: string; before: FieldValue; after: FieldValue }
export interface DiffBlock {
  id: string;
  parentIds: string[];
  fields: Record<string, DiffValue>;
}

export type StructuralChange =
  | { type: "block_added"; blockId: string; after: DiffBlock }
  | { type: "block_deleted"; blockId: string; before: DiffBlock }
  | { type: "block_text_changed"; blockId: string; before: FieldValue; after: FieldValue }
  | { type: "block_properties_changed"; blockId: string; changes: FieldChange[] }
  | { type: "block_structure_changed"; blockId: string; changes: FieldChange[]; beforeParentIds: string[]; afterParentIds: string[] };

export interface DocDiff {
  scope: "document_blocks";
  structural: StructuralChange[];
  unified: string;
  stats: { added: number; deleted: number; changed: number };
}

const STRUCTURE_FIELDS = new Set(["sys:parent", "sys:children", "prop:childElementIds"]);

function byteView(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function ownObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rawEntries(value: Y.Map<unknown> | Map<unknown, unknown> | Record<string, unknown>): Array<[string, unknown]> {
  if (value instanceof Y.Map) return [...value.entries()].map(([key, entry]) => [String(key), entry]);
  if (value instanceof Map) return [...value.entries()].map(([key, entry]) => [String(key), entry]);
  return Object.entries(value);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  const leftBytes = byteView(left);
  const rightBytes = byteView(right);
  if (leftBytes || rightBytes) return Boolean(leftBytes && rightBytes && bytesEqual(leftBytes, rightBytes));
  if (left instanceof Y.Text || right instanceof Y.Text) {
    return left instanceof Y.Text && right instanceof Y.Text && valuesEqual(left.toDelta(), right.toDelta());
  }
  if (left instanceof Y.Array || right instanceof Y.Array) {
    return left instanceof Y.Array && right instanceof Y.Array && valuesEqual(left.toArray(), right.toArray());
  }
  if (left instanceof Y.Map || right instanceof Y.Map || left instanceof Map || right instanceof Map) {
    if (!((left instanceof Y.Map || left instanceof Map) && (right instanceof Y.Map || right instanceof Map))) return false;
    const leftEntries = rawEntries(left).sort(([a], [b]) => a.localeCompare(b));
    const rightEntries = rawEntries(right).sort(([a], [b]) => a.localeCompare(b));
    return valuesEqual(leftEntries, rightEntries);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => valuesEqual(entry, right[index]));
  }
  if (ownObject(left) || ownObject(right)) {
    if (!ownObject(left) || !ownObject(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return valuesEqual(leftKeys, rightKeys) && leftKeys.every(key => valuesEqual(left[key], right[key]));
  }
  return false;
}

function conversionError(path: string, value: unknown): never {
  const type = value === null ? "null" : value?.constructor?.name || typeof value;
  throw new Error(`Unsupported document value at ${path}: ${type}`);
}

export function toDiffValue(value: unknown, path = "$doc"): DiffValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return conversionError(path, value);
    return value;
  }
  if (value === undefined) return { kind: "undefined" };

  const bytes = byteView(value);
  if (bytes) {
    return {
      kind: "bytes",
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  if (value instanceof Y.Text) {
    const deltas = value.toDelta().map((delta: { insert: unknown; attributes?: Record<string, unknown> }, index: number) => {
      const converted: { insert: DiffValue; attributes?: Record<string, DiffValue> } = {
        insert: toDiffValue(delta.insert, `${path}.deltas[${index}].insert`),
      };
      if (delta.attributes !== undefined) {
        const attributes: Record<string, DiffValue> = {};
        for (const key of Object.keys(delta.attributes).sort()) {
          attributes[key] = toDiffValue(delta.attributes[key], `${path}.deltas[${index}].attributes.${key}`);
        }
        converted.attributes = attributes;
      }
      return converted;
    });
    return { kind: "text", deltas };
  }
  if (value instanceof Y.Array) {
    return { kind: "yarray", items: value.toArray().map((entry, index) => toDiffValue(entry, `${path}[${index}]`)) };
  }
  if (value instanceof Y.Map || value instanceof Map) {
    const entries: Record<string, DiffValue> = {};
    for (const [key, entry] of rawEntries(value).sort(([a], [b]) => a.localeCompare(b))) {
      entries[key] = toDiffValue(entry, `${path}.${key}`);
    }
    return { kind: "map", entries };
  }
  if (Array.isArray(value)) {
    return { kind: "array", items: value.map((entry, index) => toDiffValue(entry, `${path}[${index}]`)) };
  }
  if (ownObject(value)) {
    const entries: Record<string, DiffValue> = {};
    for (const key of Object.keys(value).sort()) entries[key] = toDiffValue(value[key], `${path}.${key}`);
    return { kind: "object", entries };
  }
  return conversionError(path, value);
}

function childIds(value: unknown): string[] {
  if (!(value instanceof Y.Array)) return [];
  const ids: string[] = [];
  for (const entry of value.toArray()) {
    if (typeof entry === "string") ids.push(entry);
    else if (Array.isArray(entry)) {
      for (const child of entry) if (typeof child === "string") ids.push(child);
    }
  }
  return ids;
}

function parentIndex(blocks: Y.Map<unknown>, path: string): Map<string, string[]> {
  const parents = new Map<string, Set<string>>();
  for (const [ownerId, raw] of blocks.entries()) {
    if (!(raw instanceof Y.Map)) return conversionError(`${path}.${String(ownerId)}`, raw);
    const explicit = raw.get("sys:parent");
    if (typeof explicit === "string" && explicit.length > 0) {
      const set = parents.get(String(ownerId)) ?? new Set<string>();
      set.add(explicit);
      parents.set(String(ownerId), set);
    }
    for (const childId of childIds(raw.get("sys:children"))) {
      const set = parents.get(childId) ?? new Set<string>();
      set.add(String(ownerId));
      parents.set(childId, set);
    }
  }
  return new Map([...parents].map(([id, ids]) => [id, [...ids].sort()]));
}

function blockFields(block: Y.Map<unknown>, path: string): Record<string, DiffValue> {
  const fields: Record<string, DiffValue> = {};
  for (const [key, value] of [...block.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    fields[key] = toDiffValue(value, `${path}.${key}`);
  }
  return fields;
}

function fieldValue(block: Y.Map<unknown>, key: string, path: string): FieldValue {
  return block.has(key)
    ? { present: true, value: toDiffValue(block.get(key), `${path}.${key}`) }
    : { present: false };
}

function changedFields(before: Y.Map<unknown>, after: Y.Map<unknown>, keys: string[], path: string): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const key of keys.sort()) {
    const beforePresent = before.has(key);
    const afterPresent = after.has(key);
    if (beforePresent === afterPresent && (!beforePresent || valuesEqual(before.get(key), after.get(key)))) continue;
    changes.push({
      key,
      before: fieldValue(before, key, `${path}.before`),
      after: fieldValue(after, key, `${path}.after`),
    });
  }
  return changes;
}

function renderField(value: FieldValue): string {
  return value.present ? JSON.stringify(value.value) : "<absent>";
}

function renderUnified(
  changes: StructuralChange[],
  beforeBlocks: Y.Map<unknown>,
  afterBlocks: Y.Map<unknown>,
  beforeParents: Map<string, string[]>,
  afterParents: Map<string, string[]>,
): string {
  const lines: string[] = [];
  for (const change of changes) {
    const raw = afterBlocks.get(change.blockId) ?? beforeBlocks.get(change.blockId);
    const block = raw instanceof Y.Map ? raw : null;
    const parents = afterBlocks.has(change.blockId)
      ? afterParents.get(change.blockId) ?? []
      : beforeParents.get(change.blockId) ?? [];
    lines.push(
      `@@ ${change.type} ${change.blockId} parent=${JSON.stringify(parents)} ` +
      `flavour=${JSON.stringify(block?.get("sys:flavour") ?? null)} type=${JSON.stringify(block?.get("prop:type") ?? null)} @@`,
    );
    if (change.type === "block_added") lines.push(`+ ${JSON.stringify(change.after)}`);
    else if (change.type === "block_deleted") lines.push(`- ${JSON.stringify(change.before)}`);
    else if (change.type === "block_text_changed") {
      lines.push(`- prop:text ${renderField(change.before)}`, `+ prop:text ${renderField(change.after)}`);
    } else {
      if (change.type === "block_structure_changed") {
        lines.push(`- parentIds ${JSON.stringify(change.beforeParentIds)}`, `+ parentIds ${JSON.stringify(change.afterParentIds)}`);
      }
      for (const field of change.changes) {
        lines.push(`- ${field.key} ${renderField(field.before)}`, `+ ${field.key} ${renderField(field.after)}`);
      }
    }
  }
  return lines.join("\n");
}

export function diffDocStates(base: Y.Doc, proposed: Y.Doc): DocDiff {
  const beforeBlocks = base.getMap("blocks") as Y.Map<unknown>;
  const afterBlocks = proposed.getMap("blocks") as Y.Map<unknown>;
  const beforeParents = parentIndex(beforeBlocks, "$base.blocks");
  const afterParents = parentIndex(afterBlocks, "$proposed.blocks");
  const ids = [...new Set([...beforeBlocks.keys(), ...afterBlocks.keys()].map(String))].sort();
  const structural: StructuralChange[] = [];
  let added = 0;
  let deleted = 0;
  const changedIds = new Set<string>();

  for (const id of ids) {
    const before = beforeBlocks.get(id);
    const after = afterBlocks.get(id);
    const beforePresent = beforeBlocks.has(id);
    const afterPresent = afterBlocks.has(id);
    if (!beforePresent && afterPresent) {
      if (!(after instanceof Y.Map)) return conversionError(`$proposed.blocks.${id}`, after);
      structural.push({ type: "block_added", blockId: id, after: { id, parentIds: afterParents.get(id) ?? [], fields: blockFields(after, `$proposed.blocks.${id}`) } });
      added += 1;
      continue;
    }
    if (!afterPresent && beforePresent) {
      if (!(before instanceof Y.Map)) return conversionError(`$base.blocks.${id}`, before);
      structural.push({ type: "block_deleted", blockId: id, before: { id, parentIds: beforeParents.get(id) ?? [], fields: blockFields(before, `$base.blocks.${id}`) } });
      deleted += 1;
      continue;
    }
    if (!(before instanceof Y.Map)) return conversionError(`$base.blocks.${id}`, before);
    if (!(after instanceof Y.Map)) return conversionError(`$proposed.blocks.${id}`, after);

    if (before.has("prop:text") !== after.has("prop:text") || !valuesEqual(before.get("prop:text"), after.get("prop:text"))) {
      structural.push({
        type: "block_text_changed",
        blockId: id,
        before: fieldValue(before, "prop:text", `$base.blocks.${id}`),
        after: fieldValue(after, "prop:text", `$proposed.blocks.${id}`),
      });
      changedIds.add(id);
    }
    const keys = [...new Set([...before.keys(), ...after.keys()])].map(String).filter(key => key !== "prop:text");
    const structureKeys = keys.filter(key => STRUCTURE_FIELDS.has(key));
    const propertyKeys = keys.filter(key => !STRUCTURE_FIELDS.has(key));
    const structureChanges = changedFields(before, after, structureKeys, `$blocks.${id}`);
    const beforeParentIds = beforeParents.get(id) ?? [];
    const afterParentIds = afterParents.get(id) ?? [];
    if (structureChanges.length > 0 || !valuesEqual(beforeParentIds, afterParentIds)) {
      structural.push({ type: "block_structure_changed", blockId: id, changes: structureChanges, beforeParentIds, afterParentIds });
      changedIds.add(id);
    }
    const propertyChanges = changedFields(before, after, propertyKeys, `$blocks.${id}`);
    if (propertyChanges.length > 0) {
      structural.push({ type: "block_properties_changed", blockId: id, changes: propertyChanges });
      changedIds.add(id);
    }
  }

  return {
    scope: "document_blocks",
    structural,
    unified: renderUnified(structural, beforeBlocks, afterBlocks, beforeParents, afterParents),
    stats: { added, deleted, changed: changedIds.size },
  };
}
