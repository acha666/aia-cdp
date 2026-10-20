// Downloads on a real socket (implementation slice 3): the seed of tests/helpers/seed-downloads.ts in
// an FsStore under a temporary directory, createApp served by @hono/node-server's serve() on a free
// port, read with node:http, plus a raw socket where the bytes after the header block matter. Only
// what createApp().request() cannot show lives here (tests/http/downloads.test.ts has the rest):
// the header block Node writes for GET and HEAD, HEAD's Content-Length without Transfer-Encoding,
// HEAD and 304 without a body on the wire, and the values tests/helpers/runtime-downloads.ts
// expects of both runtimes (scripts/worker-smoke.ts checks the same ones on workerd).
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { derToPem, PEM_BLOCK_MARKERS } from "../../src/core/pki/pem.ts";
import type { PemBlockMarkers } from "../../src/core/pki/pem.ts";
import { createApp } from "../../src/http/app.ts";
import { FsStore } from "../../src/storage/fs.ts";
import { fixture } from "../fixtures/pki.ts";
import { testDeps } from "../helpers/app.ts";
import { cert } from "../helpers/catalog.ts";
import { comparedHeaders, rootCaDownloads, sha256Of } from "../helpers/runtime-downloads.ts";
import { DOWNLOAD_PATHS, SEED_CRLS, seedDownloads } from "../helpers/seed-downloads.ts";

const TIMEOUT = 20_000;

interface Reply {
  status: number;
  /** Name / value pairs in wire order (IncomingMessage.rawHeaders), without Date. */
  rawHeaders: [string, string][];
  headers: IncomingHttpHeaders;
  body: Uint8Array;
}

interface RawReply {
  /** The status line and header fields, as sent. */
  head: string;
  /** Everything after the blank line that ends the header block, until the server closed. */
  after: Uint8Array;
}

/** A served path and the body GET must send: the DER fixture or the PEM derived from it. */
interface Served {
  path: string;
  body: Uint8Array;
}

function pem(der: Uint8Array, { begin, end }: PemBlockMarkers): Uint8Array {
  return new TextEncoder().encode(derToPem(der, begin, end));
}

const ROOT_DER = fixture(cert("root-ca").der);
const FULL_DER = fixture(SEED_CRLS.full);

const SERVED: Served[] = [
  { path: DOWNLOAD_PATHS.root, body: ROOT_DER },
  { path: `${DOWNLOAD_PATHS.root}.pem`, body: pem(ROOT_DER, PEM_BLOCK_MARKERS.certificate) },
  { path: DOWNLOAD_PATHS.full, body: FULL_DER },
  { path: `${DOWNLOAD_PATHS.full}.pem`, body: pem(FULL_DER, PEM_BLOCK_MARKERS.crl) },
];

let scratch: string;
let server: Server;
let port: number;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aia-cdp-downloads-"));
  const store = new FsStore(scratch);
  await seedDownloads(store);
  const app = createApp(testDeps({ store }));
  // Without a createServer option serve() returns a node:http Server (as in src/runtime/node.ts).
  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as Server;
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
}, TIMEOUT);

afterAll(async () => {
  if (server?.listening) {
    const closed = new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    server.closeAllConnections();
    await closed;
  }
  await rm(scratch, { recursive: true, force: true });
});

/** One request through node:http, on its own connection (`agent: false`). */
async function send(
  method: string,
  path: string,
  headers: Record<string, string> = {}
): Promise<Reply> {
  const req = request({ host: "127.0.0.1", port, method, path, headers, agent: false });
  req.end();
  const [res] = (await once(req, "response")) as [IncomingMessage];
  const chunks: Buffer[] = [];
  for await (const chunk of res) {
    chunks.push(chunk as Buffer);
  }
  const pairs: [string, string][] = [];
  for (let i = 0; i < res.rawHeaders.length; i += 2) {
    const name = res.rawHeaders[i] ?? "";
    if (name.toLowerCase() !== "date") {
      pairs.push([name, res.rawHeaders[i + 1] ?? ""]);
    }
  }
  return {
    status: res.statusCode ?? 0,
    rawHeaders: pairs,
    headers: res.headers,
    body: new Uint8Array(Buffer.concat(chunks)),
  };
}

/**
 * One request on a raw socket (`Connection: close`), so that bytes after the header block are seen
 * for HEAD and 304, where node:http stops reading.
 */
async function sendRaw(method: string, path: string, extra = ""): Promise<RawReply> {
  const socket = connect(port, "127.0.0.1");
  socket.setTimeout(5_000, () => socket.destroy(new Error("raw request timed out")));
  await once(socket, "connect");
  // Not socket.end(): a half-closed client makes Node's http server abort the request.
  socket.write(
    `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n${extra}\r\n`
  );
  const chunks: Buffer[] = [];
  for await (const chunk of socket) {
    chunks.push(chunk as Buffer);
  }
  const all = Buffer.concat(chunks);
  const end = all.indexOf("\r\n\r\n");
  expect(end).toBeGreaterThan(0);
  return { head: all.subarray(0, end).toString("latin1"), after: all.subarray(end + 4) };
}

function header(reply: Reply, name: string): string | undefined {
  const value = reply.headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : value;
}

describe("downloads through @hono/node-server on the fs store", { timeout: TIMEOUT }, () => {
  it.each(SERVED)("GET and HEAD $path send the same header block", async ({ path, body }) => {
    const get = await send("GET", path);
    const head = await send("HEAD", path);
    expect(get.status).toBe(200);
    expect(head.status).toBe(200);
    // Same names, values and order on the wire, Connection and Keep-Alive included.
    expect(head.rawHeaders).toEqual(get.rawHeaders);
    expect(header(head, "Content-Length")).toBe(String(get.body.byteLength));
    expect(header(get, "Transfer-Encoding")).toBeUndefined();
    expect(header(head, "Transfer-Encoding")).toBeUndefined();
    expect(head.body.byteLength).toBe(0);
    expect(sha256Of(get.body)).toBe(sha256Of(body));
  });

  it.each(SERVED)(
    "HEAD $path: Content-Length and nothing after the header block",
    async ({ path, body }) => {
      const raw = await sendRaw("HEAD", path);
      expect(raw.head).toMatch(/^HTTP\/1\.1 200 /);
      expect(raw.head).toMatch(new RegExp(`\\r\\ncontent-length: ${body.byteLength}\\r\\n`, "i"));
      expect(raw.head).not.toMatch(/\r\ntransfer-encoding:/i);
      expect(raw.after.byteLength).toBe(0);
    }
  );

  it.each(SERVED)("If-None-Match on $path: 304 for GET and HEAD, no body", async ({ path }) => {
    const { headers } = await send("HEAD", path);
    const etag = headers.etag ?? "";
    expect(etag).toMatch(/^"[0-9a-f]{64}(-pem)?"$/);
    for (const method of ["GET", "HEAD"]) {
      const reply = await send(method, path, { "If-None-Match": etag });
      expect(reply.status, method).toBe(304);
      expect(header(reply, "ETag"), method).toBe(etag);
      expect(header(reply, "Cache-Control"), method).toBe(headers["cache-control"]);
      expect(header(reply, "Content-Length"), method).toBeUndefined();
      expect(header(reply, "Content-Type"), method).toBeUndefined();
      expect(header(reply, "Transfer-Encoding"), method).toBeUndefined();

      const raw = await sendRaw(method, path, `If-None-Match: ${etag}\r\n`);
      expect(raw.head, method).toMatch(/^HTTP\/1\.1 304 /);
      expect(raw.after.byteLength, method).toBe(0);
    }
  });

  // The cross-runtime half of exit "GET / HEAD 两条运行时一致": the Worker smoke compares workerd's
  // answers with the same expectation.
  it.each(rootCaDownloads())(
    "$path: ETag, Content-Length, Content-Type and Cache-Control as on workerd",
    async ({ path, headers, bodySha256 }) => {
      for (const method of ["GET", "HEAD"]) {
        const reply = await send(method, path);
        expect(reply.status, method).toBe(200);
        expect(
          comparedHeaders((name) => header(reply, name)),
          method
        ).toEqual(headers);
        if (method === "GET") {
          expect(sha256Of(reply.body)).toBe(bodySha256);
        }
      }
    }
  );
});
