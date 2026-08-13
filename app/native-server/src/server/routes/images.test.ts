import { PassThrough } from 'node:stream';
import { storeImage, absolutizeImageUrls, patchRawResponseForImageUrls } from './images';

// 1x1 transparent PNG
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('storeImage', () => {
  it('returns distinct ids and keys', () => {
    const a = storeImage(PNG_BASE64, 'image/png');
    const b = storeImage(PNG_BASE64, 'image/png');
    expect(a.id).not.toEqual(b.id);
    expect(a.key).not.toEqual(b.key);
    expect(a.key.length).toBeGreaterThan(20);
  });

  it('rejects unsupported content types', () => {
    expect(() => storeImage(PNG_BASE64, 'text/html')).toThrow(/Unsupported content type/);
  });

  it('rejects empty data', () => {
    expect(() => storeImage('', 'image/png')).toThrow(/empty/);
  });
});

describe('absolutizeImageUrls', () => {
  it('rewrites urls inside a JSON-encoded MCP payload', () => {
    const inner = JSON.stringify({ imageUrl: '/images/abc?key=k1', fullPath: 'C:/x.png' });
    const payload = JSON.stringify({ content: [{ type: 'text', text: inner }] });

    const out = absolutizeImageUrls(payload, '100.109.168.72:12306');

    const text = JSON.parse(out).content[0].text;
    expect(JSON.parse(text).imageUrl).toBe('http://100.109.168.72:12306/images/abc?key=k1');
  });

  it('rewrites urls in a plain JSON body', () => {
    const payload = JSON.stringify({ imageUrl: '/images/abc?key=k1' });
    const out = absolutizeImageUrls(payload, '127.0.0.1:12306');
    expect(JSON.parse(out).imageUrl).toBe('http://127.0.0.1:12306/images/abc?key=k1');
  });

  it('leaves the payload alone without a host header', () => {
    const payload = JSON.stringify({ imageUrl: '/images/abc?key=k1' });
    expect(absolutizeImageUrls(payload, undefined)).toBe(payload);
  });

  it('ignores a host header carrying junk', () => {
    const payload = JSON.stringify({ imageUrl: '/images/abc?key=k1' });
    expect(absolutizeImageUrls(payload, 'evil.com/"><script>')).toBe(payload);
  });
});

describe('patchRawResponseForImageUrls', () => {
  // The MCP transport writes Uint8Array, not Buffer, and frames the JSON in an
  // SSE `data:` line. Both details broke the rewrite before.
  function fakeResponse() {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    // headersSent stays undefined (falsy), which is what the patch checks.
    const raw = Object.assign(stream, {
      removeHeader: () => undefined,
      writeHead: () => raw,
    }) as unknown as import('node:http').ServerResponse;
    return { raw, read: () => Buffer.concat(chunks).toString('utf8') };
  }

  function sseFrame(): string {
    const inner = JSON.stringify({ imageUrl: '/images/abc?key=k1' });
    const body = JSON.stringify({ result: { content: [{ type: 'text', text: inner }] } });
    return `event: message\ndata: ${body}\n\n`;
  }

  it('rewrites a Uint8Array chunk written by the MCP transport', () => {
    const { raw, read } = fakeResponse();
    patchRawResponseForImageUrls(raw, '100.109.168.72:12306');

    raw.write(new Uint8Array(Buffer.from(sseFrame(), 'utf8')) as any);

    expect(read()).toContain('http://100.109.168.72:12306/images/abc?key=k1');
  });

  it('rewrites a string chunk passed to end()', () => {
    const { raw, read } = fakeResponse();
    patchRawResponseForImageUrls(raw, '127.0.0.1:12306');

    raw.end(sseFrame());

    expect(read()).toContain('http://127.0.0.1:12306/images/abc?key=k1');
  });
});
