export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function fetchJson(url, options = {}) {
  let response;
  try { response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(12000) }); }
  catch { throw new HttpError(502, 'Connection failed. Check the address and network, then try again.'); }
  if (!response.ok) {
    const message = response.status === 401 || response.status === 403 ? 'Authentication failed. Check your API key or token.' : response.status === 429 ? 'The provider is rate limiting requests. Cold Harbour will retry automatically.' : `The provider returned HTTP ${response.status}.`;
    throw new HttpError(502, message);
  }
  try { return await response.json(); } catch { throw new HttpError(502, 'The provider returned an invalid response.'); }
}

export async function readJson(req,maxBytes=65536) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415,'Send JSON data.');
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBytes) throw new HttpError(413,'Request is too large.');
  }
  try { const value = JSON.parse(body); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new HttpError(400,'Invalid JSON object.'); }
}

export function json(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
