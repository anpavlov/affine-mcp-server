export const MAX_HTTP_RESPONSE_BYTES = 16 * 1024 * 1024;

type ResponseLike = {
  body: unknown;
  headers: {
    get(name: string): string | null;
  };
};

type ResponseBody = AsyncIterable<Uint8Array> & {
  cancel?: () => Promise<void>;
  destroy?: () => void;
};

type FetchResponseBodyOptions = {
  label: string;
  maxResponseBytes?: number;
  timeoutMs: number;
};

function cancelResponseBody(response: ResponseLike): void {
  const body = response.body as ResponseBody | null;
  if (typeof body?.destroy === "function") {
    body.destroy();
    return;
  }
  if (typeof body?.cancel === "function") {
    void body.cancel().catch(() => undefined);
  }
}

export async function readLimitedResponseBytes(
  response: ResponseLike,
  maxResponseBytes: number,
  label: string,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
      cancelResponseBody(response);
      throw new Error(
        `${label} declared ${declaredLength} bytes; the configured limit is ${maxResponseBytes} bytes.`,
      );
    }
  }

  if (!response.body) {
    return new Uint8Array();
  }

  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of response.body as ResponseBody) {
    const buffer = Buffer.from(chunk);
    receivedBytes += buffer.length;
    if (receivedBytes > maxResponseBytes) {
      cancelResponseBody(response);
      throw new Error(
        `${label} exceeded the configured limit of ${maxResponseBytes} bytes.`,
      );
    }
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export async function readLimitedResponseBody(
  response: ResponseLike,
  maxResponseBytes: number,
  label: string,
): Promise<string> {
  return Buffer.from(await readLimitedResponseBytes(response, maxResponseBytes, label)).toString("utf8");
}

export async function fetchResponseBytes<T extends ResponseLike>(
  request: (signal: AbortSignal) => Promise<T>,
  {
    label,
    maxResponseBytes = MAX_HTTP_RESPONSE_BYTES,
    timeoutMs,
  }: FetchResponseBodyOptions,
): Promise<{ response: T; body: Uint8Array }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await request(controller.signal);
    const body = await readLimitedResponseBytes(response, maxResponseBytes, `${label} response`);
    return { response, body };
  } catch (error) {
    if (controller.signal.aborted) {
      const duration = timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}s` : `${timeoutMs}ms`;
      throw new Error(`${label} timed out after ${duration}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchResponseBody<T extends ResponseLike>(
  request: (signal: AbortSignal) => Promise<T>,
  options: FetchResponseBodyOptions,
): Promise<{ response: T; body: string }> {
  const { response, body } = await fetchResponseBytes(request, options);
  return { response, body: Buffer.from(body).toString("utf8") };
}
