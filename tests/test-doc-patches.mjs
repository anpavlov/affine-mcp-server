import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as Y from "yjs";

import { diffDocStates } from "../src/docDiff.ts";
import { createDocPatchManager, createDocPatchStore, DocPatchError } from "../src/docPatches.ts";
import { toolOutputSchemaFor } from "../src/toolOutputSchemas.ts";
import { registerDocTools } from "../src/tools/docs.ts";

function text(value, attributes) {
  const result = new Y.Text();
  if (value) result.insert(0, value, attributes);
  return result;
}

function block(id, flavour, content = "") {
  const value = new Y.Map();
  value.set("sys:id", id);
  value.set("sys:flavour", flavour);
  value.set("sys:version", 1);
  value.set("sys:parent", null);
  value.set("sys:children", new Y.Array());
  if (content !== undefined) value.set("prop:text", text(content));
  return value;
}

function fixture() {
  const doc = new Y.Doc();
  const blocks = doc.getMap("blocks");
  const page = block("page", "affine:page", undefined);
  const note = block("note", "affine:note", undefined);
  const paragraph = block("p1", "affine:paragraph", "before");
  paragraph.set("prop:type", "text");
  blocks.set("page", page);
  blocks.set("note", note);
  blocks.set("p1", paragraph);
  page.get("sys:children").push(["note"]);
  note.get("sys:children").push(["p1"]);
  return doc;
}

function bytes(doc) {
  return new Uint8Array(Y.encodeStateAsUpdate(doc));
}

function clone(doc) {
  const result = new Y.Doc();
  Y.applyUpdate(result, bytes(doc));
  return result;
}

let currentDoc = fixture();
let pushes = [];
const manager = createDocPatchManager({
  loadCurrent: async () => bytes(currentDoc),
  pushUpdate: async (_workspaceId, _docId, update) => pushes.push(new Uint8Array(update)),
  randomId: () => "dp_11111111111111111111111111111111",
});

const prepared = await manager.prepare({
  workspaceId: "workspace",
  docId: "doc",
  input: { operations: [{ type: "fixture" }] },
  mutate(proposed) {
    const blocks = proposed.getMap("blocks");
    blocks.get("p1").set("prop:text", text("after", { bold: true }));
    const inserted = block("p2", "affine:paragraph", "new");
    inserted.set("prop:type", "quote");
    blocks.set("p2", inserted);
    blocks.get("note").get("sys:children").push(["p2"]);
  },
});

assert.equal(pushes.length, 0, "prepare must not push");
assert.equal(currentDoc.getMap("blocks").get("p1").get("prop:text").toString(), "before", "prepare mutated base");
assert.equal(prepared.status, "prepared");
assert.deepEqual(prepared.diff.stats, { added: 1, deleted: 0, changed: 2 });
assert.equal("update" in prepared, false);
assert.equal(JSON.stringify(prepared).includes("baseSnapshotHash"), false);

const applyResult = await manager.apply(prepared.patchId);
assert.equal(applyResult.status, "consumed");
assert.equal(pushes.length, 1);
const applied = clone(currentDoc);
Y.applyUpdate(applied, pushes[0]);
assert.equal(applied.getMap("blocks").get("p1").get("prop:text").toString(), "after");
assert.equal(applied.getMap("blocks").get("p2").get("prop:text").toString(), "new");
await assert.rejects(manager.apply(prepared.patchId), error => error instanceof DocPatchError && error.code === "PATCH_CONSUMED");
assert.equal(pushes.length, 1, "consumed patch pushed twice");

await assert.rejects(
  createDocPatchManager({
    loadCurrent: async () => bytes(currentDoc), pushUpdate: async () => {},
    randomId: () => "dp_22222222222222222222222222222222",
  }).prepare({ workspaceId: "w", docId: "d", input: {}, mutate() {} }),
  error => error instanceof DocPatchError && error.code === "PATCH_NO_CHANGES",
);

const staleBase = fixture();
let staleCurrent = bytes(staleBase);
let stalePushes = 0;
const staleManager = createDocPatchManager({
  loadCurrent: async () => staleCurrent,
  pushUpdate: async () => { stalePushes += 1; },
  randomId: () => "dp_33333333333333333333333333333333",
});
const stalePatch = await staleManager.prepare({
  workspaceId: "w", docId: "d", input: {},
  mutate: doc => doc.getMap("blocks").get("p1").set("prop:text", text("proposal")),
});
const concurrent = clone(staleBase);
concurrent.getMap("blocks").delete("p1");
staleCurrent = bytes(concurrent);
await assert.rejects(staleManager.apply(stalePatch.patchId), error => error.code === "PATCH_STALE");
await assert.rejects(staleManager.apply(stalePatch.patchId), error => error.code === "PATCH_STALE");
assert.equal(stalePushes, 0);

let releaseLoad;
let loadCount = 0;
const busyStore = createDocPatchStore();
const busyManager = createDocPatchManager({
  store: busyStore,
  loadCurrent: async () => {
    loadCount += 1;
    if (loadCount === 1) return bytes(staleBase);
    return new Promise(resolve => { releaseLoad = resolve; });
  },
  pushUpdate: async () => {},
  randomId: () => "dp_44444444444444444444444444444444",
});
const busyPatch = await busyManager.prepare({
  workspaceId: "w", docId: "d", input: {},
  mutate: doc => doc.getMap("blocks").get("p1").set("prop:text", text("busy")),
});
const applying = busyManager.apply(busyPatch.patchId);
await Promise.resolve();
const otherBusyManager = createDocPatchManager({
  store: busyStore,
  loadCurrent: async () => { assert.fail("busy patch must not load again"); },
  pushUpdate: async () => { assert.fail("busy patch must not push again"); },
});
assert.throws(() => otherBusyManager.discard(busyPatch.patchId), error => error.code === "PATCH_BUSY");
await assert.rejects(otherBusyManager.apply(busyPatch.patchId), error => error.code === "PATCH_BUSY");
releaseLoad(bytes(staleBase));
await applying;

const unknownManager = createDocPatchManager({
  loadCurrent: async () => bytes(staleBase),
  pushUpdate: async () => { throw new Error("lost ack"); },
  randomId: () => "dp_55555555555555555555555555555555",
});
const unknownPatch = await unknownManager.prepare({
  workspaceId: "w", docId: "d", input: {},
  mutate: doc => doc.getMap("blocks").get("p1").set("prop:text", text("unknown")),
});
await assert.rejects(unknownManager.apply(unknownPatch.patchId), error => error.code === "PATCH_APPLY_UNKNOWN");
await assert.rejects(unknownManager.apply(unknownPatch.patchId), error => error.code === "PATCH_APPLY_UNKNOWN");

let clock = 1_000;
const expiringManager = createDocPatchManager({
  loadCurrent: async () => bytes(staleBase), pushUpdate: async () => {}, now: () => clock, ttlMs: 10,
  randomId: () => "dp_66666666666666666666666666666666",
});
const expiringPatch = await expiringManager.prepare({
  workspaceId: "w", docId: "d", input: {},
  mutate: doc => doc.getMap("blocks").get("p1").set("prop:text", text("expires")),
});
clock += 10;
await assert.rejects(expiringManager.apply(expiringPatch.patchId), error => error.code === "PATCH_EXPIRED");

const discardedManager = createDocPatchManager({
  loadCurrent: async () => bytes(staleBase), pushUpdate: async () => {},
  randomId: () => "dp_77777777777777777777777777777777",
});
const discardedPatch = await discardedManager.prepare({
  workspaceId: "w", docId: "d", input: {},
  mutate: doc => doc.getMap("blocks").get("p1").set("prop:text", text("discard")),
});
assert.equal(discardedManager.discard(discardedPatch.patchId).status, "discarded");
assert.equal(discardedManager.discard(discardedPatch.patchId).status, "discarded");
await assert.rejects(discardedManager.apply(discardedPatch.patchId), error => error.code === "PATCH_DISCARDED");
assert.equal(discardedManager.discard("dp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").status, "not_found");

let oversizedLoads = 0;
const boundedManager = createDocPatchManager({
  loadCurrent: async () => { oversizedLoads += 1; return bytes(staleBase); },
  pushUpdate: async () => {}, maxInputBytes: 8,
  randomId: () => "dp_88888888888888888888888888888888",
});
await assert.rejects(boundedManager.prepare({
  workspaceId: "w", docId: "d", input: { tooLarge: "xxxxxxxx" },
  mutate: doc => doc.getMap("blocks").get("p1").set("prop:text", text("bounded")),
}), error => error.code === "PATCH_TOO_LARGE");
assert.equal(oversizedLoads, 0, "oversized input loaded the document");

const fullManager = createDocPatchManager({
  loadCurrent: async () => bytes(staleBase), pushUpdate: async () => {}, maxRecords: 0,
  randomId: () => "dp_99999999999999999999999999999999",
});
await assert.rejects(fullManager.prepare({
  workspaceId: "w", docId: "d", input: {},
  mutate: doc => doc.getMap("blocks").get("p1").set("prop:text", text("full")),
}), error => error.code === "PATCH_STORE_FULL");
await assert.rejects(
  createDocPatchManager({ loadCurrent: async () => bytes(staleBase), pushUpdate: async () => {} })
    .apply(discardedPatch.patchId),
  error => error.code === "PATCH_NOT_FOUND",
  "separate stores must remain isolated",
);

const limitedStore = createDocPatchStore();
let storeClock = 1000;
const limitedDependencies = {
  store: limitedStore, maxRecords: 1, ttlMs: 10, now: () => storeClock,
  loadCurrent: async () => bytes(staleBase), pushUpdate: async () => {},
};
const limitedA = createDocPatchManager({ ...limitedDependencies, scope: "a" });
const limitedB = createDocPatchManager({ ...limitedDependencies, scope: "b" });
const limitedInput = {
  workspaceId: "w", docId: "d", input: {},
  mutate: doc => doc.getMap("blocks").get("p1").set("prop:text", text("limited")),
};
const limitedPatch = await limitedA.prepare(limitedInput);
assert.equal(limitedB.discard(limitedPatch.patchId).status, "not_found");
await assert.rejects(limitedB.prepare(limitedInput), error => error.code === "PATCH_STORE_FULL");
storeClock += 10;
await assert.rejects(createDocPatchManager({ ...limitedDependencies, scope: "a" }).apply(limitedPatch.patchId),
  error => error.code === "PATCH_EXPIRED");
assert.ok((await limitedB.prepare(limitedInput)).patchId, "expired records must release shared capacity");

const binaryBase = fixture();
const originalBuffer = Uint8Array.from([9, 1, 2, 3, 9]);
binaryBase.getMap("blocks").get("p1").set("prop:data", { nested: originalBuffer.subarray(1, 4) });
binaryBase.getMap("blocks").get("p1").set("prop:text", text("binary", { token: Uint8Array.from([4, 5]) }));
const binaryLoaded = clone(binaryBase);
const binarySame = clone(binaryLoaded);
assert.equal(diffDocStates(binaryLoaded, binarySame).structural.length, 0, "equal binary views changed");
const binaryChanged = clone(binaryLoaded);
binaryChanged.getMap("blocks").get("p1").set("prop:data", { nested: Uint8Array.from([1, 8, 3]) });
const binaryDiff = diffDocStates(binaryLoaded, binaryChanged);
const serializedBinaryDiff = JSON.stringify(binaryDiff);
assert.match(serializedBinaryDiff, /"kind":"bytes","byteLength":3,"sha256":"[0-9a-f]{64}"/);
assert.equal(serializedBinaryDiff.includes("AQID"), false, "diff leaked base64 bytes");
assert.equal(serializedBinaryDiff.includes("\"items\":[1,2,3]"), false, "diff leaked byte array");

const richBase = fixture();
const richChanged = clone(richBase);
richChanged.getMap("blocks").get("p1").set("prop:text", text("before", {
  bold: true,
  reference: { type: "LinkedPage", pageId: "linked-doc" },
}));
richChanged.getMap("blocks").get("p1").set("prop:custom", { nested: [true, "value"] });
const table = block("table", "affine:table", undefined);
table.set("prop:cells.r1:c1.text", text("cell", { italic: true }));
richChanged.getMap("blocks").set("table", table);
richChanged.getMap("blocks").get("note").get("sys:children").insert(0, ["table"]);
richChanged.getMap("blocks").set("orphan", block("orphan", "future:unknown", "orphan"));
const richDiff = diffDocStates(richBase, richChanged);
assert.ok(richDiff.structural.some(change => change.type === "block_text_changed" && change.blockId === "p1"));
assert.ok(richDiff.structural.some(change => change.type === "block_properties_changed" && change.blockId === "p1"));
assert.ok(richDiff.structural.some(change => change.type === "block_structure_changed" && change.blockId === "note"));
assert.ok(richDiff.structural.some(change => change.type === "block_added" && change.blockId === "orphan"));
assert.match(richDiff.unified, /LinkedPage/);
assert.match(richDiff.unified, /future:unknown/);

const deleteBase = clone(richChanged);
const deleteChanged = clone(deleteBase);
deleteChanged.getMap("blocks").delete("table");
const noteChildren = deleteChanged.getMap("blocks").get("note").get("sys:children");
noteChildren.delete(noteChildren.toArray().indexOf("table"), 1);
const deleteDiff = diffDocStates(deleteBase, deleteChanged);
assert.ok(deleteDiff.structural.some(change => change.type === "block_deleted" && change.blockId === "table"));
assert.ok(deleteDiff.structural.some(change => change.type === "block_structure_changed" && change.blockId === "note"));

const largeBinaryBase = fixture();
const largeBinaryChanged = clone(largeBinaryBase);
largeBinaryChanged.getMap("blocks").get("p1").set("prop:large", new Uint8Array(1024 * 1024).fill(7));
const largeBinaryJson = JSON.stringify(diffDocStates(largeBinaryBase, largeBinaryChanged));
assert.ok(largeBinaryJson.length < 10_000, "binary diff size followed raw payload size");
assert.match(largeBinaryJson, /"byteLength":1048576/);

let connectionAttempts = 0;
const mcpServer = new McpServer({ name: "patch-contract", version: "1.0.0" });
const originalRegisterTool = mcpServer.registerTool.bind(mcpServer);
mcpServer.registerTool = (name, options, handler) => originalRegisterTool(
  name,
  { ...options, outputSchema: options.outputSchema ?? toolOutputSchemaFor(name) },
  handler,
);
registerDocTools(mcpServer, {
  async getConnectionAuth() {
    connectionAttempts += 1;
    throw new Error("invalid patch input reached the backend");
  },
}, { workspaceId: "workspace" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "patch-contract-client", version: "1.0.0" });
await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
const listed = await client.listTools();
const patchDefinitions = Object.fromEntries(listed.tools.filter(tool => tool.name.includes("doc_patch")).map(tool => [tool.name, tool]));
assert.equal(patchDefinitions.prepare_doc_patch.inputSchema.additionalProperties, false);
assert.equal(patchDefinitions.apply_doc_patch.inputSchema.additionalProperties, false);
assert.equal(patchDefinitions.prepare_doc_patch.outputSchema.additionalProperties, false);
assert.equal("update" in (patchDefinitions.prepare_doc_patch.outputSchema?.properties ?? {}), false);
const invalidPrepare = await client.callTool({
  name: "prepare_doc_patch",
  arguments: {
    docId: "doc",
    operations: [{ type: "replace_block_text", blockId: "p1", text: "next" }],
    extra: true,
  },
});
assert.equal(invalidPrepare.isError, true);
const invalidApply = await client.callTool({
  name: "apply_doc_patch",
  arguments: { patchId: "dp_11111111111111111111111111111111", operations: [] },
});
assert.equal(invalidApply.isError, true);
assert.equal(connectionAttempts, 0, "strict MCP input reached backend code");
await clientTransport.close();

// Real registered handlers on independent MCP connections, sharing only storage.
const sharedStore = createDocPatchStore();
const sharedDoc = fixture();
let sharedPushes = 0;
async function patchSession(store = sharedStore, cookie = "account-a", endpoint = "https://affine.test/graphql") {
  const server = new McpServer({ name: "cross-session", version: "1" });
  const register = server.registerTool.bind(server);
  server.registerTool = (name, options, handler) => register(name, {
    ...options, outputSchema: toolOutputSchemaFor(name),
  }, handler);
  registerDocTools(server, {
    getConnectionAuth: async () => ({ endpoint, cookie }),
  }, { workspaceId: "workspace" }, {
    store,
    backend: {
      loadCurrent: async () => bytes(sharedDoc),
      pushUpdate: async (_w, _d, update) => {
        sharedPushes++;
        Y.applyUpdate(sharedDoc, update);
      },
    },
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "cross-session", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: () => ct.close() };
}
function payload(result) {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}
const first = await patchSession();
const prepareAcross = async (session, value) => payload(await session.client.callTool({
  name: "prepare_doc_patch", arguments: {
    docId: "doc", operations: [{ type: "replace_block_text", blockId: "p1", text: value }],
  },
}));
const crossPatch = await prepareAcross(first, "across sessions");
assert.ok(crossPatch.patchId);
assert.equal(sharedPushes, 0);
await first.close();
const second = await patchSession();
const otherAccount = await patchSession(sharedStore, "account-b");
const otherEndpoint = await patchSession(sharedStore, "account-a", "https://other.test/graphql");
const restarted = await patchSession(createDocPatchStore());
for (const session of [otherAccount, otherEndpoint, restarted]) {
  const result = await session.client.callTool({ name: "apply_doc_patch", arguments: { patchId: crossPatch.patchId } });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /PATCH_NOT_FOUND/);
  await session.close();
}
const crossApplied = await second.client.callTool({ name: "apply_doc_patch", arguments: { patchId: crossPatch.patchId } });
assert.equal(payload(crossApplied).status, "consumed");
assert.equal(sharedPushes, 1);
assert.equal(sharedDoc.getMap("blocks").get("p1").get("prop:text").toString(), "across sessions");
const third = await patchSession();
const replay = await third.client.callTool({ name: "apply_doc_patch", arguments: { patchId: crossPatch.patchId } });
assert.match(JSON.stringify(replay), /PATCH_CONSUMED/);
const crossDiscardedPatch = await prepareAcross(second, "discard this");
const crossDiscarded = await third.client.callTool({ name: "discard_doc_patch", arguments: { patchId: crossDiscardedPatch.patchId } });
assert.equal(payload(crossDiscarded).status, "discarded");
const discardedApply = await second.client.callTool({ name: "apply_doc_patch", arguments: { patchId: crossDiscardedPatch.patchId } });
assert.match(JSON.stringify(discardedApply), /PATCH_DISCARDED/);
assert.equal(sharedPushes, 1);
await second.close();
await third.close();
sharedDoc.destroy();

for (const doc of [currentDoc, applied, staleBase, concurrent, binaryBase, binaryLoaded, binarySame, binaryChanged, richBase, richChanged, deleteBase, deleteChanged, largeBinaryBase, largeBinaryChanged]) doc.destroy();
console.log("Verified document patch diff, immutable update, lifecycle, stale checks, and binary fingerprints.");
