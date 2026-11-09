// Kanboard's JSON-RPC API (https://docs.kanboard.org/v1/api/), called as the
// agent's own Kanboard user: HTTP Basic with the user name and that user's API
// token on `/jsonrpc.php`, so Kanboard's roles and project permissions decide
// what is allowed and every write is attributed to that user. One request per
// call, or one batch request for several calls (the API supports batches).

export type KanboardAuth = { username: string; token: string };

export type RpcCall = { method: string; params?: Record<string, unknown> | unknown[] };

/** What a call that did not return a result ended in; `kind` says where it stopped. */
export class KanboardError extends Error {
  /** `http`: the status was not 200 and no JSON-RPC error explained it; `rpc`: a JSON-RPC error object; `network`: no answer; `protocol`: an answer that is not JSON-RPC. */
  readonly kind: "http" | "rpc" | "network" | "protocol";
  readonly status: number | null;
  /** The JSON-RPC error code, when `kind` is `rpc` (Kanboard uses 401 and 403 here too). */
  readonly code: number | null;
  readonly data: unknown;

  constructor(kind: KanboardError["kind"], message: string, opts: { status?: number | null; code?: number | null; data?: unknown } = {}) {
    super(message);
    this.name = "KanboardError";
    this.kind = kind;
    this.status = opts.status ?? null;
    this.code = opts.code ?? null;
    this.data = opts.data;
  }

  /** Kanboard refused the user's credentials. */
  get unauthorized() {
    return this.status === 401 || this.code === 401;
  }
  /** Kanboard refused the operation for this user: no permission, or no such object (Kanboard does not tell them apart). */
  get forbidden() {
    return this.status === 403 || this.code === 403;
  }
}

type RpcResponse = { jsonrpc?: string; id?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };

export class Kanboard {
  readonly url: string;
  private readonly timeout: number;
  private nextId = 1;

  constructor(url: string, timeout = 30_000) {
    this.url = url;
    this.timeout = timeout;
  }

  /** One procedure, as `auth`'s user. Resolves to the `result`; a JSON-RPC error, a non-200 status or no answer throws a `KanboardError`. */
  async call<T = unknown>(auth: KanboardAuth, method: string, params?: RpcCall["params"]): Promise<T> {
    const id = this.nextId++;
    const body = await this.post(auth, { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    if (Array.isArray(body)) throw new KanboardError("protocol", `Kanboard answered a batch to a single call of ${method}`);
    return unwrap(method, body) as T;
  }

  /**
   * Several procedures in one request, in order. Each entry is the call's result or the
   * `KanboardError` it ended in; the batch as a whole throws only when nothing came back.
   */
  async batch(auth: KanboardAuth, calls: RpcCall[]): Promise<Array<unknown | KanboardError>> {
    if (calls.length === 0) return [];
    const ids = calls.map(() => this.nextId++);
    const body = await this.post(
      auth,
      calls.map((c, i) => ({ jsonrpc: "2.0", id: ids[i], method: c.method, ...(c.params === undefined ? {} : { params: c.params }) })),
    );
    const list = Array.isArray(body) ? body : [body];
    return calls.map((c, i) => {
      // Kanboard keeps the id on a batch entry's error; the position is the fallback.
      const r = list.find((x) => x && x.id === ids[i]) ?? list[i];
      if (!r) return new KanboardError("protocol", `Kanboard's batch answer has no entry for ${c.method}`);
      try {
        return unwrap(c.method, r);
      } catch (e) {
        return e as KanboardError;
      }
    });
  }

  private async post(auth: KanboardAuth, payload: unknown): Promise<RpcResponse | RpcResponse[]> {
    const method = Array.isArray(payload) ? "batch" : (payload as { method: string }).method;
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: "Basic " + Buffer.from(`${auth.username}:${auth.token}`, "utf8").toString("base64"),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeout),
        redirect: "error",
      });
    } catch (e) {
      throw new KanboardError("network", `Kanboard did not answer ${method}: ${(e as Error).message}`);
    }
    const text = await res.text();
    let body: RpcResponse | RpcResponse[] | null = null;
    try {
      body = JSON.parse(text);
    } catch {}
    if (body === null || typeof body !== "object") {
      if (res.status === 401) throw new KanboardError("http", "Kanboard refused the credentials (401)", { status: 401 });
      throw new KanboardError(res.ok ? "protocol" : "http", `Kanboard answered ${method} with ${res.status} and no JSON-RPC body${text ? `: ${text.slice(0, 200)}` : ""}`, { status: res.status });
    }
    // Kanboard sends 401 and 403 as the HTTP status *and* as the JSON-RPC error; the body carries the message.
    if (!res.ok && !Array.isArray(body) && !body.error) throw new KanboardError("http", `Kanboard answered ${method} with ${res.status}`, { status: res.status });
    if (!Array.isArray(body) && body.error) {
      throw new KanboardError("rpc", `Kanboard refused ${method}: ${body.error.message ?? "error"}${body.error.data ? ` (${JSON.stringify(body.error.data)})` : ""}`, { status: res.status, code: body.error.code ?? null, data: body.error.data });
    }
    return body;
  }
}

function unwrap(method: string, r: RpcResponse): unknown {
  if (r.error) {
    throw new KanboardError("rpc", `Kanboard refused ${method}: ${r.error.message ?? "error"}${r.error.data ? ` (${JSON.stringify(r.error.data)})` : ""}`, { code: r.error.code ?? null, data: r.error.data });
  }
  if (!("result" in r)) throw new KanboardError("protocol", `Kanboard's answer to ${method} has neither result nor error`);
  return r.result;
}
