import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetch } from "undici";
import * as Y from "yjs";
import { z } from "zod";

import { diffDocStates } from "../docDiff.js";
import { MAX_DOC_PATCH_RESULT_BYTES } from "../docPatches.js";
import { GraphQLClient } from "../graphqlClient.js";
import { fetchResponseBytes, MAX_HTTP_RESPONSE_BYTES } from "../util/httpResponse.js";
import { BoundedHistoryTake } from "../util/inputSchemas.js";
import { text, toolError } from "../util/mcp.js";
import { connectWorkspaceSocket, joinWorkspace, loadDoc, wsUrlFromGraphQLEndpoint } from "../ws.js";

const HISTORY_FETCH_TIMEOUT_MS = 30_000;
const Timestamp = z.string().datetime({ offset: true });
type ProjectReadDoc = (doc: Y.Doc, docId: string, options?: { includeMarkdown?: boolean }) => Record<string, unknown>;

function normalizedTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid history timestamp '${value}'.`);
  return date.toISOString();
}

function historyUrl(endpoint: string, workspaceId: string, docId: string, timestamp: string): string {
  return `${new URL(endpoint).origin}/api/workspaces/${encodeURIComponent(workspaceId)}/docs/${encodeURIComponent(docId)}/histories/${encodeURIComponent(timestamp)}`;
}

export async function loadDocRevisionBytes(
  gql: Pick<GraphQLClient, "getConnectionAuth">,
  workspaceId: string,
  docId: string,
  timestamp: string,
): Promise<Uint8Array> {
  const connection = await gql.getConnectionAuth();
  const { response, body } = await fetchResponseBytes(
    signal => fetch(historyUrl(connection.endpoint, workspaceId, docId, normalizedTimestamp(timestamp)), {
      method: "GET",
      headers: { Accept: "application/octet-stream", ...connection.headers },
      redirect: "manual",
      signal,
    }),
    { label: `Document history ${docId}`, maxResponseBytes: MAX_HTTP_RESPONSE_BYTES, timeoutMs: HISTORY_FETCH_TIMEOUT_MS },
  );
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`Document history endpoint returned redirect ${response.status}; redirects are disabled.`);
  }
  if (!response.ok) throw new Error(`Document history request failed with HTTP ${response.status} ${response.statusText}.`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/octet-stream")) {
    throw new Error(`Document history returned '${contentType || "no content type"}' instead of application/octet-stream.`);
  }
  return new Uint8Array(body);
}

export async function loadDocRevision(
  gql: Pick<GraphQLClient, "getConnectionAuth">,
  workspaceId: string,
  docId: string,
  timestamp: string,
): Promise<Y.Doc> {
  const bytes = await loadDocRevisionBytes(gql, workspaceId, docId, timestamp);
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, bytes);
    return doc;
  } catch (error) {
    doc.destroy();
    throw new Error(`Document history ${timestamp} is not a valid Yjs snapshot: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function boundedResult<T extends Record<string, unknown>>(result: T): T {
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_DOC_PATCH_RESULT_BYTES) {
    throw new Error(`History result exceeds ${MAX_DOC_PATCH_RESULT_BYTES} bytes.`);
  }
  return result;
}

export function registerHistoryTools(
  server: McpServer,
  gql: GraphQLClient,
  defaults: { workspaceId?: string },
  projectReadDoc?: ProjectReadDoc,
) {
  const listHistoriesHandler = async (parsed: { workspaceId?: string; guid: string; take?: number; before?: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId required (or set AFFINE_WORKSPACE_ID)");
    const query = `query Histories($workspaceId:String!,$guid:String!,$take:Int,$before:DateTime){ workspace(id:$workspaceId){ histories(guid:$guid, take:$take, before:$before){ id timestamp workspaceId } } }`;
    const data = await gql.request<{ workspace: any }>(query, { workspaceId, guid: parsed.guid, take: parsed.take, before: parsed.before });
    return text(data.workspace.histories);
  };
  server.registerTool("list_histories", {
    title: "List Histories",
    description: "List doc histories (timestamps) for a doc.",
    inputSchema: {
      workspaceId: z.string().optional(), guid: z.string(),
      take: BoundedHistoryTake.optional().describe("Maximum history entries to return (1-200)."),
      before: z.string().optional(),
    },
  }, listHistoriesHandler as any);

  const ReadDocRevisionInput = z.object({
    workspaceId: z.string().min(1).optional(), docId: z.string().min(1),
    timestamp: Timestamp, includeMarkdown: z.boolean().optional(),
  }).strict();
  const DiffDocRevisionInput = z.object({
    workspaceId: z.string().min(1).optional(), docId: z.string().min(1),
    fromTimestamp: Timestamp, toTimestamp: Timestamp.optional(),
  }).strict();

  const readDocRevisionHandler = async (raw: unknown) => {
    const parsed = ReadDocRevisionInput.parse(raw);
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) return toolError("workspaceId required (or set AFFINE_WORKSPACE_ID)", { code: "HISTORY_WORKSPACE_REQUIRED" });
    if (!projectReadDoc) return toolError("Historical document projection is unavailable.", { code: "HISTORY_PROJECTION_UNAVAILABLE" });
    let doc: Y.Doc | undefined;
    try {
      doc = await loadDocRevision(gql, workspaceId, parsed.docId, parsed.timestamp);
      return text(boundedResult(projectReadDoc(doc, parsed.docId, { includeMarkdown: parsed.includeMarkdown })));
    } catch (error) {
      return toolError(error, { code: "HISTORY_READ_FAILED" });
    } finally {
      doc?.destroy();
    }
  };

  const diffDocRevisionHandler = async (raw: unknown) => {
    const parsed = DiffDocRevisionInput.parse(raw);
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) return toolError("workspaceId required (or set AFFINE_WORKSPACE_ID)", { code: "HISTORY_WORKSPACE_REQUIRED" });
    let fromDoc: Y.Doc | undefined;
    let toDoc: Y.Doc | undefined;
    try {
      fromDoc = await loadDocRevision(gql, workspaceId, parsed.docId, parsed.fromTimestamp);
      if (parsed.toTimestamp) {
        toDoc = await loadDocRevision(gql, workspaceId, parsed.docId, parsed.toTimestamp);
      } else {
        const connection = await gql.getConnectionAuth();
        const socket = await connectWorkspaceSocket(wsUrlFromGraphQLEndpoint(connection.endpoint), connection.cookie, connection.bearer);
        try {
          await joinWorkspace(socket, workspaceId);
          const snapshot = await loadDoc(socket, workspaceId, parsed.docId);
          if (!snapshot.missing) throw new Error(`Current document ${parsed.docId} was not found.`);
          toDoc = new Y.Doc();
          Y.applyUpdate(toDoc, Buffer.from(snapshot.missing, "base64"));
        } finally {
          socket.disconnect();
        }
      }
      return text(boundedResult({
        workspaceId,
        docId: parsed.docId,
        fromTimestamp: normalizedTimestamp(parsed.fromTimestamp),
        toTimestamp: parsed.toTimestamp ? normalizedTimestamp(parsed.toTimestamp) : null,
        to: parsed.toTimestamp ? "revision" : "current",
        diff: diffDocStates(fromDoc, toDoc),
      }));
    } catch (error) {
      return toolError(error, { code: "HISTORY_DIFF_FAILED" });
    } finally {
      fromDoc?.destroy();
      toDoc?.destroy();
    }
  };

  server.registerTool("read_doc_revision", {
    title: "Read Document Revision",
    description: "Read one historical binary document snapshot using the same public projection as read_doc.",
    inputSchema: ReadDocRevisionInput,
  } as any, readDocRevisionHandler as any);
  server.registerTool("diff_doc_revision", {
    title: "Diff Document Revision",
    description: "Compare one historical snapshot with another revision or the current document state.",
    inputSchema: DiffDocRevisionInput,
  } as any, diffDocRevisionHandler as any);
}
