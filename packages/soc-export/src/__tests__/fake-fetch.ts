export interface RecordedRequest {
  url: string;
  init?: RequestInit | undefined;
}

type Handler = (url: string, init?: RequestInit) => Response;

/**
 * A fetch fake with a scripted queue: each call consumes the next response,
 * and every call is recorded. An empty queue means the code made a request
 * the test did not expect — that fails loudly instead of hanging.
 */
export class FakeFetch {
  readonly calls: RecordedRequest[] = [];
  private readonly queue: Handler[];

  constructor(...queue: Handler[]) {
    this.queue = [...queue];
  }

  readonly fetch: typeof fetch = async (url, init) => {
    this.calls.push({ url: String(url), init });
    const handler = this.queue.shift();
    if (!handler) throw new Error(`unexpected fetch to ${String(url)}`);
    return handler(String(url), init);
  };

  /** The named field of the first request's multipart body, if it is a form. */
  formField(name: string): unknown {
    const body = this.calls[0]?.init?.['body'];
    return body instanceof FormData ? body.get(name) : null;
  }
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}
