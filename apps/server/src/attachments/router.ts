import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, badRequest } from '../util.ts';
import type { AttachmentService } from './service.ts';

const ID = /^[A-Za-z0-9_.-]{1,100}$/;
const ATTACHMENT_ID = /^att_[a-f0-9]{32}$/;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(res.req?.method === 'HEAD' ? undefined : payload);
}

/** URLSearchParams has already decoded the query value; a header is used verbatim as display metadata. */
function uploadName(req: IncomingMessage, url: URL): string | undefined {
  const headerName = req.headers['x-mingle-filename'] ?? req.headers['x-relay-filename'];
  const raw = url.searchParams.get('name') ?? (typeof headerName === 'string' ? headerName : undefined);
  if (raw === undefined) return undefined;
  if (raw.length > 1024) throw badRequest('The file name is too long.');
  return raw;
}

/**
 * Binary attachment endpoints. They bypass the JSON router because bodies are streamed and downloads are raw bytes.
 * Returns false for any other path so the caller continues to the ordinary API.
 */
export async function handleAttachmentRequest(service: AttachmentService, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const method = (req.method ?? 'GET').toUpperCase();
  const upload = /^\/api\/(sessions|groups)\/([^/]+)\/attachments$/.exec(url.pathname);
  if (upload) {
    const id = decodeURIComponent(upload[2]!);
    if (!ID.test(id)) throw new HttpError(404, 'Not found');
    if (method === 'GET') {
      const drafts = service.listDrafts({ kind: upload[1] === 'sessions' ? 'session' : 'group', id });
      sendJson(res, 200, drafts);
      return true;
    }
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const type = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : undefined;
    try {
      const ref = await service.upload(req, { scope: { kind: upload[1] === 'sessions' ? 'session' : 'group', id }, name: uploadName(req, url), declaredType: type });
      sendJson(res, 201, ref);
    } catch (error) {
      // A refused upload may leave an unread body; closing the connection avoids waiting for the rest of it.
      if (!res.headersSent) res.setHeader('Connection', 'close');
      throw error;
    }
    return true;
  }
  const content = /^\/api\/attachments\/([^/]+)\/content$/.exec(url.pathname);
  if (content) {
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    const id = decodeURIComponent(content[1]!);
    if (!ATTACHMENT_ID.test(id)) throw new HttpError(404, 'Not found');
    await service.serve(req, res, id, url.searchParams.get('download') === 'true');
    return true;
  }
  const single = /^\/api\/attachments\/([^/]+)$/.exec(url.pathname);
  if (single) {
    if (method !== 'DELETE') throw new HttpError(405, 'Method not allowed');
    const id = decodeURIComponent(single[1]!);
    if (!ATTACHMENT_ID.test(id)) throw new HttpError(404, 'Not found');
    await service.discard(id);
    sendJson(res, 200, { ok: true });
    return true;
  }
  return false;
}
