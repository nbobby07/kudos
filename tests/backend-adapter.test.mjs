import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createBackendAdapter } from '../backend-adapter.js';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('../fixtures/checkout-revisions.json', import.meta.url)));
const payload = { projectId: manifest.projectId, commitSha: manifest.revisions.broken, requirementId: 'declined-payment-retry' };
const token = 'test_private_backend_token_0123456789';
const prefix = '/api/verification';
const context = { sender: 'Aryan', recipient: 'Noel', contractSnapshot: { contractVersion: 1, requirements: [] } };

// Explicit test-only store; production must use the compiled PostgreSQL store.
function memoryStore() {
  const records = new Map();
  let revision = 0;
  const copy = value => structuredClone(value);
  const conflict = () => { const error = new Error('private conflict'); error.name = 'IntegrationConflictError'; throw error; };
  return {
    async begin(key, submission, context) {
      const existing = records.get(key);
      if (existing) {
        if (JSON.stringify(existing.submission) !== JSON.stringify(submission)) conflict();
        return copy(existing);
      }
      const record = { requestKey: key, upstreamKey: randomUUID(), submission: copy(submission), context: copy(context), runId: null, status: null, revision: ++revision };
      records.set(key, record);
      return copy(record);
    },
    async getByKey(key) { return copy(records.get(key) ?? null); },
    async getByRun(id) { return copy([...records.values()].find(record => record.runId === id) ?? null); },
    async listPending(limit = 100) { return copy([...records.values()].filter(record => !['completed', 'error'].includes(record.status?.state)).slice(0, limit)); },
    async listRecent(limit = 100) { return copy([...records.values()].slice(-limit)); },
    async accept(key, runId) {
      const record = records.get(key);
      if (record.runId && record.runId !== runId) conflict();
      if ([...records.values()].some(other => other !== record && other.runId === runId)) conflict();
      if (!record.runId) { record.runId = runId; record.revision = ++revision; }
      return copy(record);
    },
    async updateStatus(key, status) {
      const record = records.get(key);
      const rank = { queued: 0, preparing: 1, verifying: 2, completed: 3, error: 3 };
      if (!record.status || (!['completed', 'error'].includes(record.status.state) && rank[status.state] >= rank[record.status.state]
        && JSON.stringify(record.status) !== JSON.stringify(status))) {
        record.status = copy(status); record.revision = ++revision;
      }
      return copy(record);
    },
    async snapshot() { return { revision, runs: copy([...records.values()]) }; }
  };
}

async function fixture(t, options = {}, adapterOptions = {}) {
  const calls = [];
  const runId = randomUUID();
  const evidenceId = randomUUID();
  let reply = async (req, res) => {
    if (req.url === '/submissions') { res.writeHead(202, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ runId, secret: token })); }
    else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ...payload, runId, state: 'queued', evidenceRefs: [] })); }
  };
  const backend = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() });
    await reply(req, res);
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const env = { VERIFICATION_MODE: 'real', VERIFICATION_BACKEND_URL: `http://127.0.0.1:${backend.address().port}`,
    VERIFICATION_BACKEND_TOKEN: token, VERIFICATION_TIMEOUT_MS: '150', ...options };
  const store = adapterOptions.store ?? memoryStore();
  let adapter = createBackendAdapter(env, { store, getContext: () => context, ...adapterOptions });
  const server = http.createServer(async (req, res) => {
    if (!adapter.protect(req, res)) return;
    if (!await adapter.handle(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await adapter.stop();
    server.closeAllConnections(); backend.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => backend.close(resolve))]);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { calls, runId, evidenceId, env, base, adapter, store, setReply: fn => { reply = fn; },
    reconstruct: async () => { await adapter.stop(); adapter = createBackendAdapter(env, { store, getContext: () => context, ...adapterOptions }); return adapter; },
    request: (route, init) => fetch(base + route, init),
    submit: (body = payload, key = randomUUID()) => fetch(base + prefix + '/submissions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) }) };
}

function response(res, body, status = 200, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-Upstream-Secret': token, ...headers });
  res.end(JSON.stringify(body));
}

test('exact manifest payload, accepted ID, sanitized status, session scoping and no browser credentials', async t => {
  const f = await fixture(t);
  const accepted = await f.submit();
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { runId: f.runId });
  assert.equal(accepted.headers.get('location'), `${prefix}/runs/${f.runId}`);
  assert.equal(accepted.headers.get('cache-control'), 'no-store');
  assert.deepEqual(JSON.parse(f.calls[0].body), payload);
  assert.equal(f.calls[0].headers.authorization, `Bearer ${token}`);
  assert.equal(f.calls[0].method, 'POST');
  assert.equal(f.calls[0].url, '/submissions');
  f.setReply((req, res) => response(res, { ...payload, runId: f.runId, state: 'completed', outcome: 'passed', evidenceRefs: [], secret: token, providerUrl: 'https://secret.invalid' }));
  const status = await f.request(`${prefix}/runs/${f.runId}`);
  assert.equal(status.status, 200);
  assert.equal(status.headers.get('x-upstream-secret'), null);
  assert.deepEqual(await status.json(), { ...payload, runId: f.runId, state: 'completed', evidenceRefs: [], outcome: 'passed' });
  const count = f.calls.length;
  assert.equal((await f.request(`${prefix}/runs/${randomUUID()}`)).status, 404);
  assert.equal(f.calls.length, count);
  const second = await fixture(t);
  assert.equal((await second.request(`${prefix}/runs/${f.runId}`)).status, 404);
  assert.equal(second.calls.length, 0);
});

test('strict submission/route validation and method errors occur before upstream access', async t => {
  const f = await fixture(t);
  for (const body of [null, [], {}, { ...payload, url: 'http://evil.invalid' }, { ...payload, commitSha: 'f'.repeat(40) },
    { ...payload, projectId: 'other' }, { ...payload, requirementId: 'mobile' }, { ...payload, commitSha: manifest.revisions.fixed.toUpperCase() }]) {
    assert.equal((await f.submit(body)).status, 400);
  }
  assert.equal((await f.request(`${prefix}/submissions`, { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await f.request(`${prefix}/submissions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' })).status, 400);
   assert.equal((await f.request(`${prefix}/submissions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ' '.repeat(17000) })).status, 413);
  assert.equal((await f.request(`${prefix}/submissions?anything=1`, { method: 'POST' })).status, 400);
  const wrongMethod = await f.request(`${prefix}/submissions`);
  assert.equal(wrongMethod.status, 405); assert.equal(wrongMethod.headers.get('allow'), 'POST');
  assert.equal((await f.request(`${prefix}/runs/${f.runId}`, { method: 'POST' })).status, 405);
  assert.equal((await f.request(`${prefix}/runs/not-a-uuid`)).status, 400);
  assert.equal((await f.request(`${prefix}/runs/${f.runId}/evidence/not-a-uuid`)).status, 400);
  assert.equal((await f.request(`${prefix}/runs/${f.runId}/extra`)).status, 404);
  assert.equal((await f.request(`${prefix}/runs/${f.runId}?x=1`)).status, 400);
  assert.equal(f.calls.length, 0);
});

test('fixed revision is accepted exactly; chunked bodies are bounded and GET bodies are rejected', async t => {
  const f = await fixture(t);
  const fixed = { ...payload, commitSha: manifest.revisions.fixed };
  assert.equal((await f.submit(fixed)).status, 202);
  assert.deepEqual(JSON.parse(f.calls[0].body), fixed);
  const request = (route, method, chunks, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request(f.base + route, { method, headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
  assert.equal(await request(`${prefix}/submissions`, 'POST', [' '.repeat(9000), ' '.repeat(9000)], { 'Content-Type': 'application/json' }), 413);
  assert.equal(await request(`${prefix}/runs/${f.runId}`, 'GET', ['{}'], { 'Content-Length': '2' }), 400);
  assert.equal(f.calls.length, 1);
  // An aborted request must not crash the server or submit incomplete JSON.
  await new Promise(resolve => {
    const req = http.request(f.base + prefix + '/submissions', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    req.on('error', () => resolve());
    req.write('{');
    setTimeout(() => req.destroy(), 20);
  });
  assert.equal((await f.request(`${prefix}/runs/${randomUUID()}`)).status, 404);
  assert.equal(f.calls.length, 1);
});

test('real configuration fails closed, simulation is isolated, and legacy authority is disabled', async t => {
  for (const options of [{ VERIFICATION_BACKEND_TOKEN: '' }, { VERIFICATION_BACKEND_TOKEN: 'a b'.repeat(15) },
    { VERIFICATION_BACKEND_URL: '' }, { VERIFICATION_BACKEND_URL: 'http://example.com' },
    { VERIFICATION_BACKEND_URL: 'https://user:pass@example.com' }, { VERIFICATION_BACKEND_URL: 'https://example.com?secret=1' },
    { VERIFICATION_BACKEND_URL: 'https://example.com#secret' }, { VERIFICATION_BACKEND_URL: 'https://example.com/path' },
    { VERIFICATION_TIMEOUT_MS: 'NaN' }, { VERIFICATION_MODE: 'simulation' }]) {
    const f = await fixture(t, options);
    const result = await f.submit();
    assert.equal(result.status, 503); assert.equal((await result.text()).includes(token), false);
    assert.equal(f.calls.length, 0);
  }
  assert.equal(createBackendAdapter({}).mode, 'simulation');
  assert.throws(() => createBackendAdapter({ VERIFICATION_MODE: 'REAL' }), /VERIFICATION_MODE/);
  const f = await fixture(t);
  for (const route of ['/api/verify', '/api/acknowledge']) {
    const result = await f.request(route, { method: 'POST' });
    assert.equal(result.status, 503); assert.match(await result.text(), /Simulation is disabled/);
  }
  assert.equal(f.calls.length, 0);
});

test('omitted mode rejects complete or partial nonempty backend config with a sanitized error', async t => {
  const configs = [{ VERIFICATION_BACKEND_URL: 'https://private.invalid', VERIFICATION_BACKEND_TOKEN: token, VERIFICATION_TIMEOUT_MS: '5000' },
    { VERIFICATION_BACKEND_URL: 'https://private.invalid' }, { VERIFICATION_BACKEND_TOKEN: token }, { VERIFICATION_TIMEOUT_MS: '5000' },
    { VERIFICATION_BACKEND_URL: ' ' }];
  for (const config of configs) {
    assert.throws(() => createBackendAdapter(config), error => {
      assert.equal(error.message, 'Backend configuration requires explicit VERIFICATION_MODE.');
      return true;
    });
    const failed = await spawned(t, undefined, config, true);
    assert.notEqual(failed.exitCode, 0);
    assert.match(failed.output, /Backend configuration requires explicit VERIFICATION_MODE/);
    assert.equal(failed.output.includes('Relay listening'), false);
    assert.equal(failed.output.includes(token), false);
    assert.equal(failed.output.includes('https://private.invalid'), false);
  }
  assert.equal(createBackendAdapter({ VERIFICATION_BACKEND_URL: '', VERIFICATION_BACKEND_TOKEN: '', VERIFICATION_TIMEOUT_MS: '' }).mode, 'simulation');
  assert.equal(createBackendAdapter({ VERIFICATION_MODE: 'simulation', VERIFICATION_BACKEND_URL: 'not a URL',
    VERIFICATION_BACKEND_TOKEN: 'invalid token', VERIFICATION_TIMEOUT_MS: 'invalid timeout' }).mode, 'simulation');
  const f = await fixture(t);
  const simulation = await spawned(t, 'simulation', f.env);
  // The helper's mode must override supplied backend configuration's mode.
  assert.equal((await fetch(simulation.base + prefix + '/submissions', { method: 'POST' })).status, 503);
  assert.equal((await fetch(simulation.base + '/api/verify', { method: 'POST', body: '{}' })).status, 200);
  assert.equal(f.calls.length, 0);
});

test('upstream acceptance/errors/redirects are sanitized with no retries or redirect credential leak', async t => {
  const f = await fixture(t);
  for (const [status, body] of [[202, { runId: 'bad', token }], [200, { runId: f.runId }], [401, { error: token }],
    [500, { error: token }], [202, { runId: [f.runId] }]]) {
    f.setReply((req, res) => response(res, body, status));
    const result = await f.submit();
    assert.equal(result.status, 503); assert.equal((await result.text()).includes(token), false);
  }
  let redirected = 0;
  const destination = http.createServer((req, res) => { redirected++; res.end(token); });
  destination.listen(0, '127.0.0.1'); await once(destination, 'listening');
  t.after(() => { destination.closeAllConnections(); destination.close(); });
  f.setReply((req, res) => response(res, { error: token }, 307, { Location: `http://127.0.0.1:${destination.address().port}/leak` }));
  assert.equal((await f.submit()).status, 503);
  assert.equal(redirected, 0); assert.equal(f.calls.length, 6);
  assert.equal((await f.request(`${prefix}/runs/${f.runId}`)).status, 404);
});

test('timed-out submission acceptance stays unknown without retries or workspace association', async t => {
  const f = await fixture(t);
  let delivered;
  const delivery = new Promise(resolve => { delivered = resolve; });
  f.setReply((req, res) => {
    // The upstream has accepted work, but its acknowledgment arrives after our deadline.
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.write('{');
    setTimeout(() => { res.end(JSON.stringify({ runId: f.runId }).slice(1)); delivered(); }, 350);
  });
  const result = await f.submit();
  assert.equal(result.status, 503);
  const body = await result.text();
  assert.match(body, /acceptance may be unknown; do not automatically resubmit/);
  assert.equal(body.includes(f.runId), false); assert.equal(body.includes(token), false);
  assert.equal((await f.request(`${prefix}/runs/${f.runId}`)).status, 404);
  await delivery;
  assert.equal((await f.request(`${prefix}/runs/${f.runId}`)).status, 404);
  assert.equal((await f.request(`${prefix}/runs/${f.runId}/evidence/${f.evidenceId}`)).status, 404);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'POST');
});

test('status validates immutable identity, discriminated states, references and sanitized fields', async t => {
  const f = await fixture(t); await f.submit();
  const good = { ...payload, runId: f.runId, state: 'queued', evidenceRefs: [] };
  for (const patch of [{ runId: randomUUID() }, { commitSha: manifest.revisions.fixed }, { requirementId: 'mobile' },
    { projectId: 'other' }, { state: 'passed' }, { state: 'completed' }, { state: 'error', errorCode: token },
    { outcome: 'passed' }, { evidenceRefs: [{ id: f.evidenceId, kind: 'network', url: token }] },
    { evidenceRefs: [{ id: [f.evidenceId], kind: 'network' }] },
    { evidenceRefs: [{ id: f.evidenceId, kind: 'network' }, { id: f.evidenceId, kind: 'log' }] }]) {
    f.setReply((req, res) => response(res, { ...good, ...patch }));
    const result = await f.request(`${prefix}/runs/${f.runId}`);
    assert.equal(result.status, 503); assert.equal((await result.text()).includes(token), false);
  }
  for (const state of ['queued', 'preparing', 'verifying', 'completed']) {
    const result = { ...good, state, ...(state === 'completed' ? { outcome: 'unverified' } : state === 'error' ? { errorCode: 'timeout' } : {}) };
    f.setReply((req, res) => response(res, result));
    const actual = await f.request(`${prefix}/runs/${f.runId}`);
    assert.equal(actual.status, 200); assert.deepEqual(await actual.json(), result);
  }
});

test('evidence uses fresh matching run status, allows bounded PNG/network/log only, and rejects cross-run references', async t => {
  let f;
  let evidenceRoute;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afo0AAAAASUVORK5CYII=', 'base64');
  for (const [kind, bytes] of [['screenshot', png], ['network', Buffer.from(JSON.stringify([{ attempt: 1, method: 'POST', path: '/checkout', status: 402 }]))],
    ['log', Buffer.from(JSON.stringify([{ event: 'requirement-passed', step: 'retry' }]))]]) {
    f = await fixture(t); await f.submit();
    evidenceRoute = `${prefix}/runs/${f.runId}/evidence/${f.evidenceId}`;
    f.setReply((req, res) => {
      if (!req.url.includes('/evidence/')) response(res, { ...payload, runId: f.runId, state: 'completed', outcome: 'failed', evidenceRefs: [{ id: f.evidenceId, kind }] });
      else { res.writeHead(200, { 'Content-Type': kind === 'screenshot' ? 'image/png' : 'application/json', 'X-Upstream-Secret': token }); res.end(bytes); }
    });
    const result = await f.request(evidenceRoute);
    assert.equal(result.status, 200); assert.deepEqual(Buffer.from(await result.arrayBuffer()), bytes);
    assert.equal(result.headers.get('cache-control'), 'no-store'); assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(result.headers.get('x-upstream-secret'), null);
  }
  let artifactFetches = 0;
  f = await fixture(t); await f.submit();
  evidenceRoute = `${prefix}/runs/${f.runId}/evidence/${f.evidenceId}`;
  for (const badIdentity of [false, true]) {
    f.setReply((req, res) => {
      if (req.url.includes('/evidence/')) { artifactFetches++; response(res, []); }
      else response(res, { ...payload, runId: badIdentity ? randomUUID() : f.runId, state: 'completed', outcome: 'passed', evidenceRefs: [] });
    });
    assert.equal((await f.request(evidenceRoute)).status, badIdentity ? 503 : 404);
  }
  assert.equal(artifactFetches, 0);
  const count = f.calls.length;
  assert.equal((await f.request(`${prefix}/runs/${randomUUID()}/evidence/${f.evidenceId}`)).status, 404);
  assert.equal(f.calls.length, count);
  for (const [kind, type, bytes] of [['screenshot', 'image/png', Buffer.from('<html>bad</html>')],
    ['network', 'application/json', Buffer.from(JSON.stringify([{ attempt: 1, method: 'POST', path: '/checkout', status: 402, secret: token }]))],
    ['log', 'application/json', Buffer.from(JSON.stringify([{ event: token, step: 'retry' }]))],
    ['network', 'text/html', Buffer.from('[]')], ['network', 'application/json', Buffer.from('{bad')]]) {
    f = await fixture(t); await f.submit();
    evidenceRoute = `${prefix}/runs/${f.runId}/evidence/${f.evidenceId}`;
    f.setReply((req, res) => {
      if (!req.url.includes('/evidence/')) response(res, { ...payload, runId: f.runId, state: 'error', errorCode: 'tooling', evidenceRefs: [{ id: f.evidenceId, kind }] });
      else { res.writeHead(200, { 'Content-Type': type }); res.end(bytes); }
    });
    const result = await f.request(evidenceRoute);
    assert.equal(result.status, 503); assert.equal((await result.text()).includes(token), false);
  }
});

test('upstream waits cover headers AND streaming bodies; JSON and evidence reads have streaming bounds', async t => {
  const f = await fixture(t);
  for (const behavior of ['no-headers', 'stalled-body', 'oversize-length', 'oversize-chunked', 'bad-json', 'bad-type']) {
    f.setReply((req, res) => {
      if (behavior === 'no-headers') return;
      res.writeHead(202, { 'Content-Type': behavior === 'bad-type' ? 'text/html' : 'application/json',
        ...(behavior === 'oversize-length' ? { 'Content-Length': 17000 } : {}) });
      if (behavior === 'stalled-body') res.write('{');
      else if (behavior.startsWith('oversize')) res.end(' '.repeat(17000));
      else res.end('bad');
    });
    const start = Date.now();
    assert.equal((await f.submit()).status, 503);
    assert.ok(Date.now() - start < 2000);
  }
  f.setReply((req, res) => { res.writeHead(202, { 'Content-Type': 'application/json' }); res.end(Buffer.from([0xff])); });
  assert.equal((await f.submit()).status, 503);
  f.setReply((req, res) => response(res, { runId: f.runId }, 202)); await f.submit();
  for (const behavior of ['stalled-body', 'oversize-length', 'oversize-chunked', 'missing', 'redirect']) {
    f.setReply((req, res) => {
      if (!req.url.includes('/evidence/')) return response(res, { ...payload, runId: f.runId, state: 'completed', outcome: 'failed', evidenceRefs: [{ id: f.evidenceId, kind: 'screenshot' }] });
      if (behavior === 'missing') return response(res, { error: token }, 404);
      if (behavior === 'redirect') return response(res, { error: token }, 302, { Location: '/should-not-fetch' });
      res.writeHead(200, { 'Content-Type': 'image/png', ...(behavior === 'oversize-length' ? { 'Content-Length': 6 * 1024 * 1024 } : {}) });
      if (behavior === 'stalled-body') res.write(Buffer.from([137]));
      else res.end(Buffer.alloc(6 * 1024 * 1024));
    });
    assert.equal((await f.request(`${prefix}/runs/${f.runId}/evidence/${f.evidenceId}`)).status, behavior === 'missing' ? 404 : 503);
  }
});

test('private boundary rejects remote IP without trusting forwarded headers', () => {
  const adapter = createBackendAdapter({ VERIFICATION_MODE: 'real' });
  let status;
  const res = { setHeader() {}, writeHead(code) { status = code; }, end() {} };
  assert.equal(adapter.protect({ url: '/', socket: { remoteAddress: '192.0.2.1', localPort: 5173 },
    rawHeaders: ['Host', '127.0.0.1:5173'], headers: { host: '127.0.0.1:5173', 'x-forwarded-for': '127.0.0.1' } }, res), false);
  assert.equal(status, 403);
});

async function spawned(t, mode, config = {}, expectFailure = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-adapter-'));
  if (mode === 'real') await writeFile(path.join(directory, 'state.json'), JSON.stringify({ fixed: true, contractVersion: 1,
    requirements: [], run: { id: 'saved-demo', status: 'passed' }, handoff: { id: 'saved-demo', status: 'passed', acknowledged: false } }));
  const env = { ...process.env, DATA_DIR: directory, PORT: '0', HOST: '0.0.0.0' };
  for (const key of ['VERIFICATION_MODE', 'VERIFICATION_BACKEND_URL', 'VERIFICATION_BACKEND_TOKEN', 'VERIFICATION_TIMEOUT_MS', 'VERIFICATION_DATABASE_URL', 'VERIFICATION_WORKSPACE_ID']) delete env[key];
  Object.assign(env, config);
  if (mode === undefined) delete env.VERIFICATION_MODE;
  else env.VERIFICATION_MODE = mode;
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { child.kill(); if (child.exitCode === null && child.signalCode === null) await once(child, 'exit'); await rm(directory, { recursive: true, force: true }); });
  let output = '';
  child.stderr.on('data', chunk => { output += chunk; });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timeout')), 5000);
    child.once('close', code => { clearTimeout(timer); if (expectFailure) resolve({ exitCode: code }); else reject(new Error(`Server exited ${code}`)); });
    child.stdout.on('data', chunk => { output += chunk; const match = /Relay listening on port (\d+)/.exec(output); if (match) { clearTimeout(timer); resolve({ port: Number(match[1]) }); } });
  });
  return { ...result, output, child, directory: env.DATA_DIR, base: `http://127.0.0.1:${result.port}` };
}

function rawRequest(port, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, headers }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject); req.end();
  });
}

test('spawned real server protects root, state and all APIs against Host/Origin rebinding and disables old authority', async t => {
  const f = await spawned(t, 'real');
  assert.equal((await fetch(f.base + '/')).status, 200);
  assert.equal((await fetch(f.base + '/api/state')).status, 200);
  for (const route of ['/', '/api/state', '/api/chat', `${prefix}/submissions`]) {
    for (const headers of [{ Host: `evil.invalid:${f.port}` }, { Origin: 'https://evil.invalid' }, { Origin: 'null' },
      { Host: `localhost:${f.port}`, Origin: f.base }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' },
      { Host: `evil.invalid:${f.port}`, 'X-Forwarded-Host': `127.0.0.1:${f.port}`, 'X-Forwarded-For': '127.0.0.1' }]) {
      assert.equal((await rawRequest(f.port, route, headers)).status, 403);
    }
  }
  assert.equal((await rawRequest(f.port, '/api/state', { Origin: f.base })).status, 200);
  for (const route of ['/api/verify', '/api/acknowledge', `${prefix}/submissions`]) assert.equal((await fetch(f.base + route, { method: 'POST' })).status, 503);
  const state = await (await fetch(f.base + '/api/state')).json();
  assert.equal(state.run, null); assert.equal(state.handoff, null);
});

test('spawned default simulation server keeps existing workspace behavior', async t => {
  const f = await spawned(t);
  assert.equal((await fetch(f.base + '/api/state')).status, 200);
  assert.equal((await fetch(f.base + '/api/acknowledge', { method: 'POST', body: '{}' })).status, 200);
  const verification = await fetch(f.base + '/api/verify', { method: 'POST', body: '{}' });
  assert.equal(verification.status, 200); assert.equal((await verification.json()).run.status, 'running');
  assert.equal((await fetch(f.base + prefix + '/submissions', { method: 'POST' })).status, 503);
});

test('spawned configured real server without a durable store fails closed without upstream effects', async t => {
  const upstream = await fixture(t);
  const server = await spawned(t, 'real', { ...upstream.env, VERIFICATION_TIMEOUT_MS: '2000' });
  const stateBefore = await (await fetch(server.base + '/api/state')).json();
  assert.equal(stateBefore.run, null); assert.equal(stateBefore.handoff, null);
  const accepted = await fetch(server.base + prefix + '/submissions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal(accepted.status, 503);
  assert.equal((await accepted.text()).includes(token), false);
  const result = await fetch(server.base + prefix + '/runs/' + upstream.runId);
  assert.equal(result.status, 503);
  assert.equal(result.headers.get('x-upstream-secret'), null);
  const artifact = await fetch(server.base + prefix + '/runs/' + upstream.runId + '/evidence/' + upstream.evidenceId);
  assert.equal(artifact.status, 503);
  assert.equal(artifact.headers.get('cache-control'), 'no-store'); assert.equal(artifact.headers.get('x-upstream-secret'), null);
  assert.equal(upstream.calls.length, 0);
  for (const route of ['/api/verify', '/api/acknowledge']) assert.equal((await fetch(server.base + route, { method: 'POST', body: '{}' })).status, 503);
  const stateAfter = await (await fetch(server.base + '/api/state')).json();
  assert.deepEqual(stateAfter, stateBefore);
  assert.equal(JSON.stringify(stateAfter).includes(token), false);
  assert.equal(JSON.stringify(stateAfter).includes(upstream.runId), false);
});

test('UUID idempotency headers are required exactly once before durable or upstream effects', async t => {
  const f = await fixture(t);
  for (const key of [undefined, '', 'not-a-uuid', `${randomUUID()}, ${randomUUID()}`]) {
    const headers = { 'Content-Type': 'application/json', ...(key === undefined ? {} : { 'Idempotency-Key': key }) };
    assert.equal((await f.request(prefix + '/submissions', { method: 'POST', headers, body: JSON.stringify(payload) })).status, 400);
  }
  const duplicate = await new Promise((resolve, reject) => {
    const req = http.request(f.base + prefix + '/submissions', { method: 'POST', headers: [
      'Host', new URL(f.base).host, 'Content-Type', 'application/json',
      'Idempotency-Key', randomUUID(), 'Idempotency-Key', randomUUID()
    ] }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end(JSON.stringify(payload));
  });
  assert.equal(duplicate, 400);
  assert.deepEqual(await f.store.snapshot(), { revision: 0, runs: [] });
  assert.equal(f.calls.length, 0);
});

test('durable intent survives adapter reconstruction, ignores changed context and rejects key conflicts', async t => {
  let ownedContext = structuredClone(context);
  const f = await fixture(t, {}, { getContext: () => ownedContext });
  const key = randomUUID();
  assert.equal((await f.submit(payload, key)).status, 202);
  const original = await f.store.getByKey(key);
  assert.notEqual(original.upstreamKey, key);
  assert.equal(f.calls[0].headers['idempotency-key'], original.upstreamKey);
  ownedContext = { ...context, contractSnapshot: { contractVersion: 99 } };
  await f.reconstruct();
  const repeated = await f.submit(payload, key.toUpperCase());
  assert.equal(repeated.status, 202);
  assert.deepEqual(await repeated.json(), { runId: f.runId });
  assert.equal(f.calls.length, 1);
  const conflict = await f.submit({ ...payload, commitSha: manifest.revisions.fixed }, key);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.text()).includes('private conflict'), false);
  assert.equal(f.calls.length, 1);
  const snapshot = await (await f.request(prefix + '/context')).json();
  assert.equal(snapshot.runs[0].requestKey, key);
  assert.deepEqual(snapshot.runs[0].context, context);
  assert.equal(snapshot.runs[0].runId, f.runId);
  assert.equal(JSON.stringify(snapshot).includes(original.upstreamKey), false);
  assert.equal(JSON.stringify(snapshot).includes(token), false);
  assert.equal((await f.request(`${prefix}/runs/${f.runId}`)).status, 200);
});

test('last validated terminal status survives failed reads, stale updates and reconstruction', async t => {
  const f = await fixture(t); await f.submit();
  const terminal = { ...payload, runId: f.runId, state: 'completed', outcome: 'passed', evidenceRefs: [] };
  f.setReply((req, res) => response(res, terminal));
  assert.deepEqual(await (await f.request(`${prefix}/runs/${f.runId}`)).json(), terminal);
  f.setReply((req, res) => response(res, { error: token }, 500));
  const failed = await f.request(`${prefix}/runs/${f.runId}`);
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).statusUnavailable, true);
  await f.reconstruct();
  assert.deepEqual((await (await f.request(prefix + '/context')).json()).runs[0].status, terminal);
  f.setReply((req, res) => response(res, { ...payload, runId: f.runId, state: 'queued', evidenceRefs: [] }));
  assert.deepEqual(await (await f.request(`${prefix}/runs/${f.runId}`)).json(), terminal);
});

test('evidence authorization uses retained terminal status after a successful stale upstream read', async t => {
  const snapshots = [];
  const f = await fixture(t, {}, { onUpdate: snapshot => { snapshots.push(snapshot); } });
  await f.submit();
  const terminal = { ...payload, runId: f.runId, state: 'completed', outcome: 'passed',
    evidenceRefs: [{ id: f.evidenceId, kind: 'network' }] };
  f.setReply((req, res) => response(res, terminal));
  assert.deepEqual(await (await f.request(`${prefix}/runs/${f.runId}`)).json(), terminal);
  const original = await (await f.request(prefix + '/context')).json();
  const notifications = snapshots.length;
  const artifact = [{ attempt: 1, method: 'POST', path: '/checkout', status: 402 }];
  const stale = { ...payload, runId: f.runId, state: 'verifying', evidenceRefs: [] };
  f.setReply((req, res) => response(res, req.url.includes('/evidence/') ? artifact : stale));
  const result = await f.request(`${prefix}/runs/${f.runId}/evidence/${f.evidenceId}`);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), artifact);
  assert.deepEqual(f.calls.slice(-2).map(call => call.url), [`/runs/${f.runId}`, `/runs/${f.runId}/evidence/${f.evidenceId}`]);
  assert.deepEqual(await (await f.request(prefix + '/context')).json(), original);
  assert.equal(snapshots.length, notifications);
  const unknownEvidence = randomUUID();
  f.setReply((req, res) => response(res, { ...stale, evidenceRefs: [{ id: unknownEvidence, kind: 'network' }] }));
  assert.equal((await f.request(`${prefix}/runs/${f.runId}/evidence/${unknownEvidence}`)).status, 404);
  assert.equal(f.calls.at(-1).url, `/runs/${f.runId}`);
  for (const invalid of [{ ...stale, runId: randomUUID() }, { ...stale, commitSha: manifest.revisions.fixed }]) {
    f.setReply((req, res) => response(res, invalid));
    assert.equal((await f.request(`${prefix}/runs/${f.runId}/evidence/${f.evidenceId}`)).status, 503);
    assert.equal(f.calls.at(-1).url, `/runs/${f.runId}`);
  }
  f.setReply((req, res) => response(res, { error: token }, 500));
  assert.equal((await f.request(`${prefix}/runs/${f.runId}/evidence/${f.evidenceId}`)).status, 503);
  assert.equal(f.calls.at(-1).url, `/runs/${f.runId}`);
  assert.deepEqual(await (await f.request(prefix + '/context')).json(), original);
  assert.equal(snapshots.length, notifications);
});

test('unchanged status reads do not notify and background polling recovers after an upstream failure', async t => {
  const snapshots = [];
  const f = await fixture(t, {}, { onUpdate: snapshot => { snapshots.push(snapshot); } });
  await f.submit();
  const route = `${prefix}/runs/${f.runId}`;
  assert.equal((await f.request(route)).status, 200);
  const original = await (await f.request(prefix + '/context')).json();
  const notifications = snapshots.length;
  assert.equal((await f.request(route)).status, 200);
  assert.equal(snapshots.length, notifications);
  assert.deepEqual(await (await f.request(prefix + '/context')).json(), original);
  let reads = 0;
  const terminal = { ...payload, runId: f.runId, state: 'completed', outcome: 'passed', evidenceRefs: [] };
  f.setReply((req, res) => {
    reads++;
    response(res, reads === 1 ? { error: token } : terminal, reads === 1 ? 500 : 200);
  });
  assert.equal(await f.adapter.start(), true);
  const initializedNotifications = snapshots.length;
  const deadline = Date.now() + 5000;
  while (reads === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(reads, 1);
  assert.deepEqual(await (await f.request(prefix + '/context')).json(), original);
  assert.equal(snapshots.length, initializedNotifications);
  while ((await f.store.getByRun(f.runId)).status?.state !== 'completed' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  await f.adapter.stop();
  assert.equal(reads, 2);
  const recovered = await (await f.request(prefix + '/context')).json();
  assert.deepEqual(recovered.runs[0].status, terminal);
  assert.deepEqual(recovered.runs[0].context, original.runs[0].context);
  assert.equal(snapshots.length, initializedNotifications + 1);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('background recovery retries unknown acceptance with one immutable upstream key and polls without browser reads', async t => {
  const snapshots = [];
  const f = await fixture(t, {}, { onUpdate: snapshot => { snapshots.push(snapshot); } });
  const key = randomUUID();
  const acceptedByKey = new Map();
  let effects = 0;
  let first = true;
  f.setReply((req, res) => {
    if (req.url === '/submissions') {
      const upstreamKey = req.headers['idempotency-key'];
      if (!acceptedByKey.has(upstreamKey)) { effects++; acceptedByKey.set(upstreamKey, f.runId); }
      if (first) { first = false; return; }
      response(res, { runId: acceptedByKey.get(upstreamKey) }, 202);
    } else response(res, { ...payload, runId: f.runId, state: 'completed', outcome: 'passed', evidenceRefs: [] });
  });
  assert.equal((await f.submit(payload, key)).status, 503);
  assert.equal(f.calls.length, 1);
  const pending = await (await f.request(prefix + '/context')).json();
  assert.equal(pending.runs[0].runId, null);
  assert.equal(pending.runs[0].status, null);
  const replacement = await f.reconstruct();
  assert.equal(await replacement.start(), true);
  const deadline = Date.now() + 5000;
  while ((await f.store.getByKey(key)).status?.state !== 'completed' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  await replacement.stop();
  assert.equal((await f.store.getByKey(key)).status?.state, 'completed');
  assert.equal(effects, 1);
  const posts = f.calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].headers['idempotency-key'], posts[1].headers['idempotency-key']);
  assert.deepEqual(posts.map(call => JSON.parse(call.body)), [payload, payload]);
  assert.ok(snapshots.some(snapshot => snapshot.runs[0]?.status?.state === 'completed'));
  assert.equal(JSON.stringify(snapshots).includes(posts[0].headers['idempotency-key']), false);
  const count = f.calls.length;
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(f.calls.length, count);
});

test('upstream key conflicts and broken injected stores fail safely', async t => {
  const f = await fixture(t);
  f.setReply((req, res) => response(res, { error: token }, 409));
  const result = await f.submit();
  assert.equal(result.status, 409);
  assert.equal((await result.text()).includes(token), false);
  const broken = await fixture(t, {}, { store: {} });
  assert.equal(await broken.adapter.start(), false);
  assert.equal((await broken.submit()).status, 503);
  assert.equal((await broken.request(prefix + '/context')).status, 503);
  assert.equal(broken.calls.length, 0);
});

test('root requires explicit valid database and workspace configuration without leaking connection details', async t => {
  const upstream = await fixture(t);
  const privateDatabase = 'postgresql://private-user:private-password@127.0.0.1:1/private-db';
  for (const config of [
    { VERIFICATION_DATABASE_URL: privateDatabase },
    { VERIFICATION_WORKSPACE_ID: 'workspace-test' },
    { VERIFICATION_DATABASE_URL: 'https://private.invalid', VERIFICATION_WORKSPACE_ID: 'workspace-test' },
    { VERIFICATION_DATABASE_URL: privateDatabase, VERIFICATION_WORKSPACE_ID: ' ' }
  ]) {
    const server = await spawned(t, 'real', { ...upstream.env, ...config });
    for (const route of ['/submissions', '/context']) {
      const result = await fetch(server.base + prefix + route, route === '/submissions' ? {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(payload)
      } : {});
      assert.equal(result.status, 503);
      assert.equal((await result.text()).includes('private'), false);
    }
    assert.equal(server.output.includes(privateDatabase), false);
    assert.equal(server.output.includes(token), false);
  }
  assert.equal(upstream.calls.length, 0);
});

test('root snapshot sequence is durable across restart and concurrent writes respond with current state', async t => {
  const f = await spawned(t);
  const initial = await (await fetch(f.base + '/api/state')).json();
  assert.ok(initial.sequence > 0);
  const responses = await Promise.all(['Aryan', 'Noel', 'Kiran'].map(owner => fetch(f.base + '/api/task-preferences', {
    method: 'POST', body: JSON.stringify({ owner, enabled: false })
  }).then(response => response.json())));
  const latest = await (await fetch(f.base + '/api/state')).json();
  assert.equal(latest.sequence, initial.sequence + 3);
  assert.ok(responses.every(response => response.sequence <= latest.sequence));
  const persisted = JSON.parse(await readFile(path.join(f.directory, 'state.json'), 'utf8'));
  assert.equal(persisted.sequence, latest.sequence);
  const exited = once(f.child, 'exit');
  f.child.kill();
  await exited;
  const restarted = await spawned(t, undefined, { DATA_DIR: f.directory });
  const recovered = await (await fetch(restarted.base + '/api/state')).json();
  assert.equal(recovered.sequence, latest.sequence + 1);
  assert.deepEqual(recovered.taskPreferences, latest.taskPreferences);
});
