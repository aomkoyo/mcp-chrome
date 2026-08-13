/**
 * Image routes - lets a remote MCP client fetch screenshots over HTTP
 * instead of receiving a local file path it cannot read.
 *
 * The extension POSTs base64 image data to /images; the server keeps it in
 * memory and returns an id + key. The image is then readable at
 * GET /images/:id?key=...
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { HTTP_STATUS } from '../../constant';

// ponytail: in-memory ring, no disk. Images are transient; a restart losing
// them is fine. Switch to disk only if clients need them across restarts.
const MAX_IMAGES = 50;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

interface StoredImage {
  buffer: Buffer;
  contentType: string;
  key: string;
}

const images = new Map<string, StoredImage>();

const ALLOWED_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * Compare two keys without leaking length or content through timing.
 */
function keyMatches(expected: string, provided: unknown): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function storeImage(base64Data: string, contentType: string): { id: string; key: string } {
  const buffer = Buffer.from(base64Data, 'base64');
  if (buffer.length === 0) {
    throw new Error('Image data is empty or not valid base64');
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image exceeds ${MAX_IMAGE_BYTES} bytes`);
  }
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new Error(`Unsupported content type: ${contentType}`);
  }

  const id = randomUUID();
  const key = randomBytes(24).toString('base64url');
  images.set(id, { buffer, contentType, key });

  // Evict oldest once over capacity (Map preserves insertion order).
  while (images.size > MAX_IMAGES) {
    const oldest = images.keys().next().value;
    if (oldest === undefined) break;
    images.delete(oldest);
  }

  return { id, key };
}

/**
 * Rewrite relative /images/... URLs in an MCP response into absolute URLs
 * pointing at whatever host the client actually dialed. The extension cannot
 * know that host (it always talks to 127.0.0.1), and a remote client cannot
 * use a loopback URL.
 */
export function absolutizeImageUrls(payload: string, hostHeader: string | undefined): string {
  // ponytail: Host header only; no forwarded-proto handling since this server
  // is plain HTTP on a tailnet. Revisit if it ever sits behind TLS.
  if (!hostHeader || !payload.includes('/images/')) return payload;
  // Reject a Host header that could smuggle anything into the URL.
  if (!/^[A-Za-z0-9.\-[\]:]+$/.test(hostHeader)) return payload;
  const base = `http://${hostHeader}`;
  // The URL sits inside a JSON string that is itself JSON-encoded, so the
  // surrounding quote may be `"` or the escaped `\"`.
  return payload.replace(/(\\?")(\/images\/[^"\\]*)/g, (_m, quote, relative) => {
    return `${quote}${base}${relative}`;
  });
}

/**
 * The MCP transport writes straight to the raw response, bypassing Fastify's
 * onSend hook, so patch the raw stream to rewrite image URLs on the way out.
 */
export function patchRawResponseForImageUrls(
  raw: import('node:http').ServerResponse,
  hostHeader: string | undefined,
): void {
  if (!hostHeader) return;

  // Rewriting lengthens the body, so a precomputed Content-Length would be
  // wrong. Drop it and let the response be chunked.
  const originalWriteHead = raw.writeHead.bind(raw);
  raw.writeHead = function patchedWriteHead(this: unknown, ...writeHeadArgs: any[]): any {
    // Strip Content-Length wherever it was set: on the response object, or
    // inline in the headers object passed to writeHead.
    raw.removeHeader('Content-Length');
    for (const arg of writeHeadArgs) {
      if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
        for (const headerName of Object.keys(arg)) {
          if (headerName.toLowerCase() === 'content-length') delete arg[headerName];
        }
      }
    }
    return originalWriteHead(...(writeHeadArgs as [number]));
  } as typeof raw.writeHead;

  const rewrite = (chunk: unknown): unknown => {
    if (typeof chunk === 'string') {
      return absolutizeImageUrls(chunk, hostHeader);
    }
    if (Buffer.isBuffer(chunk)) {
      const text = chunk.toString('utf8');
      const rewritten = absolutizeImageUrls(text, hostHeader);
      return rewritten === text ? chunk : Buffer.from(rewritten, 'utf8');
    }
    return chunk;
  };

  const originalWrite = raw.write.bind(raw);
  const originalEnd = raw.end.bind(raw);

  raw.write = function patchedWrite(chunk: any, ...rest: any[]): boolean {
    return originalWrite(rewrite(chunk) as any, ...rest);
  } as typeof raw.write;

  raw.end = function patchedEnd(chunk?: any, ...rest: any[]): any {
    if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) {
      return originalEnd(rewrite(chunk) as any, ...rest);
    }
    return originalEnd(chunk, ...rest);
  } as typeof raw.end;
}

export function registerImageRoutes(fastify: FastifyInstance): void {
  fastify.post(
    '/images',
    { bodyLimit: MAX_IMAGE_BYTES },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as { base64Data?: unknown; contentType?: unknown } | undefined;
      const base64Data = body?.base64Data;
      const contentType = typeof body?.contentType === 'string' ? body.contentType : 'image/png';

      if (typeof base64Data !== 'string' || base64Data.length === 0) {
        return reply
          .status(HTTP_STATUS.BAD_REQUEST)
          .send({ error: 'base64Data (string) is required' });
      }

      try {
        const { id, key } = storeImage(base64Data, contentType);
        return reply.status(HTTP_STATUS.CREATED).send({ id, key });
      } catch (error) {
        return reply
          .status(HTTP_STATUS.BAD_REQUEST)
          .send({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  fastify.get(
    '/images/:id',
    async (
      request: FastifyRequest<{ Params: { id: string }; Querystring: { key?: string } }>,
      reply: FastifyReply,
    ) => {
      const stored = images.get(request.params.id);
      // Same reply for unknown id and wrong key, so the endpoint cannot be
      // used to probe which ids exist.
      if (!stored || !keyMatches(stored.key, request.query.key)) {
        return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Not found' });
      }

      return reply
        .header('Content-Type', stored.contentType)
        .header('Cache-Control', 'no-store')
        .status(HTTP_STATUS.OK)
        .send(stored.buffer);
    },
  );
}
