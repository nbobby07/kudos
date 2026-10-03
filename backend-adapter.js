import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('./fixtures/checkout-revisions.json', import.meta.url), 'utf8'));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JSON_LIMIT = 16 * 1024;
const EVIDENCE_LIMIT = 5 * 1024 * 1024;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const logEvents = new Set(['page-error', 'request-failed', 'requirement-passed', 'requirement-failed', 'check-interrupted', 'check-error',
  'screenshot-unavailable', 'browser-cleanup-failed', ...['log', 'debug', 'info', 'error', 'warning', 'dir', 'dirxml', 'table', 'trace',
    'clear', 'startGroup', 'startGroupCollapsed', 'endGroup', 'assert', 'profile', 'profileEnd', 'count', 'timeEnd'].map(event => `console-${event}`)]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const json = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
const jsonType = value => /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value || '');
const loopback = address => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

function send(res, status, body) {
  if (res.destroyed || res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

// Read without buffering beyond the limit, including chunked requests and stalled clients.
function readRequest(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const finish = (error, bytes) => {
      clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('error', failed); req.off('aborted', aborted);
      if (error) { req.once('error', () => {}); req.pause(); reject(error); } else resolve(bytes);
    };
    const data = chunk => {
      size += chunk.length;
      if (size > JSON_LIMIT) finish(413);
      else chunks.push(chunk);
    };
    const end = () => finish(null, Buffer.concat(chunks));
    const failed = () => finish(400);
    const aborted = () => finish(400);
    const timer = setTimeout(() => finish(408), 5000);
    req.on('data', data); req.on('end', end); req.on('error', failed); req.on('aborted', aborted);
  });
}

function validateStatus(value, runId, submission) {
  if (!object(value) || value.runId !== runId || !['queued', 'preparing', 'verifying', 'completed', 'error'].includes(value.state)
    || Object.keys(submission).some(key => value[key] !== submission[key]) || !Array.isArray(value.evidenceRefs)
    || value.evidenceRefs.length > 100 || value.evidenceRefs.some(ref => !exactKeys(ref, ['id', 'kind']) || typeof ref.id !== 'string' || !UUID.test(ref.id)
      || !['screenshot', 'network', 'log'].includes(ref.kind))
    || new Set(value.evidenceRefs.map(ref => ref.id)).size !== value.evidenceRefs.length) throw new Error('Invalid status');
  const result = { ...submission, runId, state: value.state, evidenceRefs: value.evidenceRefs.map(({ id, kind }) => ({ id, kind })) };
  if (value.state === 'completed') {
    if (!['passed', 'failed', 'unverified'].includes(value.outcome) || Object.hasOwn(value, 'errorCode')) throw new Error('Invalid outcome');
    result.outcome = value.outcome;
  } else if (value.state === 'error') {
    if (!['environment', 'tooling', 'timeout', 'interrupted'].includes(value.errorCode) || Object.hasOwn(value, 'outcome')) throw new Error('Invalid error');
    result.errorCode = value.errorCode;
  } else if (Object.hasOwn(value, 'outcome') || Object.hasOwn(value, 'errorCode')) throw new Error('Invalid nonterminal status');
  return result;
}

function validateEvidence(bytes, kind) {
  if (kind === 'screenshot') {
    if (!bytes.subarray(0, 8).equals(pngSignature)) throw new Error('Invalid PNG');
    return bytes;
  }
  const value = json(bytes);
  if (!Array.isArray(value) || value.length > 100 || value.some(entry => kind === 'network'
    ? !exactKeys(entry, ['attempt', 'method', 'path', 'status']) || !Number.isInteger(entry.attempt) || entry.attempt < 1
      || entry.attempt > 100 || entry.method !== 'POST' || entry.path !== '/checkout' || entry.status !== 402
    : !exactKeys(entry, ['event', 'step']) || !logEvents.has(entry.event) || !['launch', 'navigate', 'submit', 'declined-error', 'retry'].includes(entry.step))) {
    throw new Error('Invalid evidence');
  }
  return Buffer.from(JSON.stringify(value));
}

export function createBackendAdapter(env = process.env, options = {}) {
  if (env.VERIFICATION_MODE == null && ['VERIFICATION_BACKEND_URL', 'VERIFICATION_BACKEND_TOKEN', 'VERIFICATION_TIMEOUT_MS', 'VERIFICATION_DATABASE_URL', 'VERIFICATION_WORKSPACE_ID']
    .some(key => env[key] != null && env[key] !== '')) throw new Error('Backend configuration requires explicit VERIFICATION_MODE.');
  const mode = env.VERIFICATION_MODE ?? 'simulation';
  if (!['simulation', 'real'].includes(mode)) throw new Error('Invalid VERIFICATION_MODE');
  let base;
  let token;
  let timeout;
  if (mode === 'real') try {
    base = new URL(env.VERIFICATION_BACKEND_URL);
    token = env.VERIFICATION_BACKEND_TOKEN;
    timeout = Number(env.VERIFICATION_TIMEOUT_MS ?? 5000);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || /[?#@]/.test(env.VERIFICATION_BACKEND_URL) || base.search || base.hash
      || base.pathname !== '/' || (base.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname))
      || !/^[A-Za-z0-9_-]{32,256}$/.test(token ?? '') || !Number.isInteger(timeout) || timeout < 10 || timeout > 30000) throw new Error();
  } catch { base = undefined; token = undefined; }
  const store = options.store;
  const available = () => mode === 'real' && base && store && ['begin', 'getByKey', 'getByRun', 'listPending', 'listRecent', 'accept', 'updateStatus', 'snapshot'].every(name => typeof store[name] === 'function');
  const jobs = new Map();
  const retries = new Map();
  let timer;
  let worker;
  let stopped = true;
  let delay = 1000;
  const publicSnapshot = snapshot => ({ revision: snapshot.revision, runs: snapshot.runs.map(record => ({
    requestKey: record.requestKey, submission: record.submission, context: record.context,
    runId: record.runId, status: record.status, revision: record.revision
  })) });
  async function notify() {
    const snapshot = publicSnapshot(await store.snapshot());
    await options.onUpdate?.(snapshot);
    return snapshot;
  }
  function job(key, action) {
    if (jobs.has(key)) return jobs.get(key);
    const promise = action().finally(() => jobs.delete(key));
    jobs.set(key, promise);
    return promise;
  }
  async function submit(record) {
    return job(record.requestKey, async () => {
      record = await store.getByKey(record.requestKey);
      if (record.runId) return record;
      const accepted = json(await upstream('/submissions', 'POST', record.submission, JSON_LIMIT, 'application/json', record.upstreamKey));
      if (!object(accepted) || typeof accepted.runId !== 'string' || !UUID.test(accepted.runId)) throw new Error('Invalid acceptance');
      const saved = await store.accept(record.requestKey, accepted.runId);
      await notify();
      return saved;
    });
  }
  async function refresh(record) {
    const result = validateStatus(json(await upstream(`/runs/${record.runId}`)), record.runId, record.submission);
    const saved = await store.updateStatus(record.requestKey, result);
    if (saved.revision !== record.revision) await notify();
    return saved.status;
  }
  async function poll() {
    try {
      for (const record of await store.listPending(100)) {
        if (stopped) break;
        if (['completed', 'error'].includes(record.status?.state)) continue;
        const retry = retries.get(record.requestKey);
        if (retry && retry.at > Date.now()) continue;
        try {
          if (!record.runId) await submit(record);
          else await refresh(record);
          retries.delete(record.requestKey);
        } catch {
          const backoff = Math.min((retry?.delay ?? 500) * 2, 30000);
          retries.set(record.requestKey, { delay: backoff, at: Date.now() + backoff });
        }
      }
      delay = 1000;
    } catch { delay = Math.min(delay * 2, 30000); }
    if (!stopped) { timer = setTimeout(() => { worker = poll(); }, delay); timer.unref(); }
  }

  async function upstream(route, method = 'GET', body, limit = JSON_LIMIT, contentType = 'application/json', idempotencyKey) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response;
    try {
      response = await fetch(new URL(route, base), { method, redirect: 'manual', signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, Accept: contentType, ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      if (response.status !== (method === 'POST' ? 202 : 200)) {
        if (method === 'GET' && response.status === 404) throw 404;
        if (method === 'POST' && response.status === 409) throw 409;
        throw new Error('Unavailable');
      }
      if (contentType === 'application/json' ? !jsonType(response.headers.get('content-type')) : response.headers.get('content-type') !== contentType) throw new Error('Invalid type');
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw new Error('Oversized response');
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > limit) throw new Error('Oversized response');
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  return {
    mode,
    async initialize() {
      if (!available()) return false;
      try { await notify(); return true; } catch { return false; }
    },
    async start() {
      if (!stopped || !available()) return false;
      if (!await this.initialize()) return false;
      stopped = false;
      timer = setTimeout(() => { worker = poll(); }, delay);
      timer.unref();
      return true;
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await worker;
      await Promise.allSettled([...jobs.values()]);
    },
    protect(req, res) {
      if (mode !== 'real') return true;
      const count = name => req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length;
      const host = req.headers.host;
      const origin = req.headers.origin;
      const allowedHosts = ['127.0.0.1', 'localhost'].map(name => `${name}:${req.socket.localPort}`);
      if (!loopback(req.socket.remoteAddress) || count('host') !== 1 || !allowedHosts.includes(host)
        || count('origin') > 1 || (origin !== undefined && origin !== `http://${host}`)
        || (req.headers['sec-fetch-site'] !== undefined && !['none', 'same-origin'].includes(req.headers['sec-fetch-site']))
        || !req.url.startsWith('/') || req.url.startsWith('//')) {
        res.setHeader('Connection', 'close');
        send(res, 403, { error: 'Private loopback workspace only.' });
        return false;
      }
      return true;
    },
    async handle(req, res, url) {
      if (mode === 'real' && ['/api/verify', '/api/acknowledge'].includes(url.pathname)) {
        send(res, 503, { error: 'Real verification UI and delivery are not available yet. Simulation is disabled.' });
        return true;
      }
      if (url.pathname !== '/api/verification' && !url.pathname.startsWith('/api/verification/')) return false;
      try {
        if (!available()) { send(res, 503, { error: 'Real verification unavailable.' }); return true; }
        const submissionRoute = url.pathname === '/api/verification/submissions';
        const contextRoute = url.pathname === '/api/verification/context';
        const match = /^\/api\/verification\/runs\/([^/]+)(?:\/evidence\/([^/]+))?$/.exec(url.pathname);
        if (!submissionRoute && !contextRoute && !match) { send(res, 404, { error: 'Not found.' }); return true; }
        const method = submissionRoute ? 'POST' : 'GET';
        if (req.method !== method) { res.setHeader('Allow', method); send(res, 405, { error: 'Method not allowed.' }); return true; }
        if (url.search || req.url.includes('?') || (!submissionRoute && (req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')))) {
          send(res, 400, { error: 'Query parameters and read request bodies are not allowed.' }); return true;
        }
        if (submissionRoute) {
          if (!jsonType(req.headers['content-type']) || req.headers['content-encoding']) { send(res, 415, { error: 'Expected application/json.' }); return true; }
          let input;
          try { input = json(await readRequest(req)); } catch (error) {
            res.setHeader('Connection', 'close');
            send(res, typeof error === 'number' ? error : 400, { error: 'Invalid submission body.' }); return true;
          }
          if (!exactKeys(input, ['projectId', 'commitSha', 'requirementId']) || input.projectId !== manifest.projectId
            || !Object.values(manifest.revisions).includes(input.commitSha) || input.requirementId !== 'declined-payment-retry') {
            send(res, 400, { error: 'Choose a supported exact fixture revision and requirement.' }); return true;
          }
          const key = req.headers['idempotency-key'];
          if (typeof key !== 'string' || !UUID.test(key) || req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'idempotency-key').length !== 1) {
            send(res, 400, { error: 'Exactly one UUID Idempotency-Key is required.' }); return true;
          }
          const context = await options.getContext?.();
          const record = await store.begin(key.toLowerCase(), input, context);
          await notify();
          const accepted = record.runId ? record : await submit(record);
          res.setHeader('Location', `/api/verification/runs/${accepted.runId}`);
          send(res, 202, { runId: accepted.runId });
          return true;
        }
        if (contextRoute) { send(res, 200, publicSnapshot(await store.snapshot())); return true; }
        const [, runId, evidenceId] = match;
        if (!UUID.test(runId) || (evidenceId !== undefined && !UUID.test(evidenceId))) { send(res, 400, { error: 'Invalid identifier.' }); return true; }
        const record = await store.getByRun(runId);
        if (!record) { send(res, 404, { error: 'Run not associated with this workspace.' }); return true; }
        let status;
        try { status = await refresh(record); } catch (error) {
          if (!evidenceId) { send(res, 503, { error: 'Verification status unavailable.', statusUnavailable: true }); return true; }
          throw error;
        }
        if (!evidenceId) { send(res, 200, status); return true; }
        const ref = status.evidenceRefs.find(ref => ref.id === evidenceId);
        if (!ref) { send(res, 404, { error: 'Evidence not associated with this run.' }); return true; }
        const contentType = ref.kind === 'screenshot' ? 'image/png' : 'application/json';
        const bytes = validateEvidence(await upstream(`/runs/${runId}/evidence/${evidenceId}`, 'GET', undefined, EVIDENCE_LIMIT, contentType), ref.kind);
        res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': bytes.length, 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
        res.end(bytes);
      } catch (error) {
        const conflict = error === 409 || error?.name === 'IntegrationConflictError';
        send(res, conflict ? 409 : error === 404 ? 404 : 503, { error: conflict ? 'Submission key conflicts with existing verification intent.' : error === 404 ? 'Verification resource not found.' : 'Real verification unavailable. Submission acceptance may be unknown; do not automatically resubmit.' });
      }
      return true;
    }
  };
}
