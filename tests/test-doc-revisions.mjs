import assert from "node:assert/strict";

import * as Y from "yjs";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";

import { diffDocStates } from "../src/docDiff.ts";
import { loadDocRevision, loadDocRevisionBytes } from "../src/tools/history.ts";

function revision(value) {
  const doc = new Y.Doc();
  const block = new Y.Map();
  block.set("sys:id", "p1");
  block.set("sys:flavour", "affine:paragraph");
  block.set("prop:text", value);
  block.set("prop:binary", Uint8Array.from([1, 2, value.length]));
  doc.getMap("blocks").set("p1", block);
  return doc;
}

const first = revision("first");
const second = revision("second");
const firstBytes = Y.encodeStateAsUpdate(first);
const endpoint = "http://history.test/graphql";
const gql = {
  async getConnectionAuth() {
    return { endpoint, headers: { Authorization: "Bearer history-test" }, cookie: "", bearer: "history-test" };
  },
};
const previousDispatcher = getGlobalDispatcher();
const mockAgent = new MockAgent();
mockAgent.disableNetConnect();
setGlobalDispatcher(mockAgent);
const pool = mockAgent.get("http://history.test");
const timestamp = "2026-09-05T12:34:56+03:00";
const encodedTime = "2026-09-05T09%3A34%3A56.000Z";
const successPath = `/api/workspaces/workspace%20%2F%20one/docs/doc%2Ftwo/histories/${encodedTime}`;

function mock(path, status, body, contentType) {
  pool.intercept({
    path,
    method: "GET",
    headers: { authorization: "Bearer history-test", accept: "application/octet-stream" },
  }).reply(status, body, { headers: { "content-type": contentType } });
}

try {
  mock(successPath, 200, firstBytes, "application/octet-stream");
  const loadedBytes = await loadDocRevisionBytes(gql, "workspace / one", "doc/two", timestamp);
  assert.deepEqual(loadedBytes, firstBytes);

  const ordinaryPath = `/api/workspaces/workspace/docs/doc/histories/${encodedTime}`;
  mock(ordinaryPath, 200, firstBytes, "application/octet-stream");
  const loaded = await loadDocRevision(gql, "workspace", "doc", timestamp);
  assert.equal(loaded.getMap("blocks").get("p1").get("prop:text"), "first");
  loaded.destroy();

  mock(ordinaryPath, 404, "{}", "application/json");
  await assert.rejects(loadDocRevisionBytes(gql, "workspace", "doc", timestamp), /HTTP 404/);
  mock(ordinaryPath, 200, "{}", "application/json");
  await assert.rejects(loadDocRevisionBytes(gql, "workspace", "doc", timestamp), /instead of application\/octet-stream/);
  mock(ordinaryPath, 200, Buffer.from([255, 255, 255]), "application/octet-stream");
  await assert.rejects(loadDocRevision(gql, "workspace", "doc", timestamp), /not a valid Yjs snapshot/);
  await assert.rejects(loadDocRevisionBytes(gql, "workspace", "doc", "not-a-time"), /Invalid history timestamp/);

  const patchDiff = diffDocStates(first, second);
  const historyDiff = diffDocStates(first, second);
  assert.deepEqual(historyDiff, patchDiff, "patch and history must use one diff implementation");
  assert.match(JSON.stringify(historyDiff), /"kind":"bytes"/);
  assert.equal(JSON.stringify(historyDiff).includes("AQIF"), false);
} finally {
  first.destroy();
  second.destroy();
  await mockAgent.close();
  setGlobalDispatcher(previousDispatcher);
}

console.log("Verified binary revision loading, URL/auth handling, failures, and shared history diff.");
