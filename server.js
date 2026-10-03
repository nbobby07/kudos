import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { createBackendAdapter } from './backend-adapter.js';

const root = path.dirname(fileURLToPath(import.meta.url));
// Validate mode before loading any database module or reading workspace state.
const verificationMode = createBackendAdapter().mode;
const dataDir = process.env.DATA_DIR || path.join(root, '.data');
await mkdir(dataDir, { recursive: true });
const stateFile = path.join(dataDir, 'state.json');
const initial = { fixed: false, run: null, handoff: null, contractVersion: 1, assignment: 'Checkout UI', requirements: [
  { id: 'loading', name: 'Prevent duplicate submissions', promise: 'Disable checkout while a payment is pending.', verify: 'Delay the response and attempt a second submission.' },
  { id: 'success', name: 'Handle a successful payment', promise: 'Display confirmation with the returned order ID.', verify: 'Return an orderId and inspect the confirmation.' },
  { id: 'declined', name: 'Handle declined payments and retry', promise: 'Show a useful error and restore the checkout action.', verify: 'Return PAYMENT_DECLINED and attempt a retry.' },
  { id: 'mobile', name: 'Make checkout usable on mobile', promise: 'Keep content and the checkout button accessible at 375px.', verify: 'Check layout, horizontal overflow, and button visibility.' }
] };
let state;
try { state = JSON.parse(await readFile(stateFile, 'utf8')); } catch { state = initial; }
// Task completion is self-reported and stays separate from verification results.
state.daily ??= Object.fromEntries(['Aryan', 'Noel', 'Kiran'].map(name => [name, { version: 1, tasks: (
  name === 'Aryan' ? [
    ['loading', 'Build the pending checkout state', 'Disable the checkout button while payment is processing.'],
    ['declined', 'Handle a declined payment', 'Show the backend error and let the customer retry.'],
    ['mobile', 'Polish the mobile checkout', 'Check the layout and primary action at 375px.']
  ] : name === 'Noel' ? [
    ['endpoint', 'Build POST /checkout', 'Accept cartId and paymentToken using the shared API contract.'],
    ['responses', 'Return predictable payment responses', 'Return orderId on success and PAYMENT_DECLINED on failure.'],
    ['backend-tests', 'Test the checkout API', 'Cover valid requests, declined payments, and invalid input.']
  ] : [
    ['test-plan', 'Prepare the checkout test plan', 'Cover loading, success, failure, retry, and mobile.'],
    ['fixtures', 'Prepare payment test fixtures', 'Define consistent successful and declined payment scenarios.'],
    ['integration', 'Check the frontend and backend together', 'Confirm request and response handling against both handoffs.']
  ]).map(([id, title, description]) => ({ id, title, description, completed: false })), recommendations: (
    name === 'Aryan' ? [
      ['success', 'Add an order confirmation state', 'Show the order ID returned by the backend.', 'Complete the happy path before handing off.'],
      ['api-notes', 'Document the request mapping', 'Note where cartId and paymentToken come from.', 'Give Noel the context he needs to wire the API.']
    ] : name === 'Noel' ? [
      ['validation', 'Document validation errors', 'Describe the API behavior for missing request fields.', 'Help the frontend avoid unexpected response states.'],
      ['backend-notes', 'Write a backend handoff note', 'Summarize endpoint behavior and known limitations.', 'Give Kiran a clear starting point for testing.']
    ] : [
      ['retry-test', 'Add a retry regression test', 'Decline the first payment and succeed on the next attempt.', 'Protect the handoff behavior that matters most.'],
      ['test-notes', 'Document the integration results', 'Record what was tested and what remains unverified.', 'Help the team understand the release boundary.']
    ]).map(([id, title, description, reason]) => ({ id, title, description, reason }))
}]));
// Seed example teammate requests without overwriting anyone's saved checklist.
const teammateRequests = {
  Aryan: [
    ['Noel', 'Confirm the checkout request fields', 'Send cartId and paymentToken exactly as defined in the API contract.'],
    ['Kiran', 'Add stable selectors for checkout tests', 'Give the checkout button and payment error predictable test selectors.']
  ],
  Noel: [
    ['Aryan', 'Keep payment error messages actionable', 'Return a message the frontend can display without rewriting it.'],
    ['Kiran', 'Provide a declined-payment test fixture', 'Share a deterministic way to return PAYMENT_DECLINED in integration tests.']
  ],
  Kiran: [
    ['Aryan', 'Check the checkout flow at 375px', 'Confirm the error, retry action, and checkout button remain accessible.'],
    ['Noel', 'Cover the agreed request and response shapes', 'Test cartId, paymentToken, orderId, and PAYMENT_DECLINED against the API contract.']
  ]
};
state.deletedSeedTasks ??= [];
for (const [owner, requests] of Object.entries(teammateRequests)) {
  for (const [source, title, description] of requests) {
    const id = `teammate-${source.toLowerCase()}`;
    if (!state.deletedSeedTasks.includes(`${owner}:${id}`) && !state.daily[owner].tasks.some(task => task.id === id)) {
      state.daily[owner].tasks.push({ id, title, description, source, completed: false });
      state.daily[owner].version++;
    }
  }
}
state.deliveries ??= [];
state.messages ??= [];
state.calendar ??= [];
state.calendarDismissed ??= [];
state.calendarPreferences ??= Object.fromEntries(['Aryan', 'Noel', 'Kiran'].map(name => [name, true]));
state.taskPreferences ??= { ...state.calendarPreferences };
state.taskDismissed ??= [...state.calendarDismissed];
state.chatReadAt ??= {};
const demoLogins = { Aryan: 'aryan-checkout', Noel: 'noel-checkout', Kiran: 'kiran-checkout' };
state.github ??= {
  accounts: {}, repository: 'checkout-team/checkout', prs: [
    { number: 42, title: 'Handle declined checkout payments', author: demoLogins.Aryan, headSha: 'demo-pr-42-001', files: ['src/checkout.js'] },
    { number: 43, title: 'Return predictable checkout responses', author: demoLogins.Noel, headSha: 'demo-pr-43-001', files: ['api/checkout.js'] },
    { number: 44, title: 'Test checkout on mobile', author: demoLogins.Kiran, headSha: 'demo-pr-44-001', files: ['tests/checkout.spec.js'] }
  ]
};
state.prReviews ??= [];
for (const review of state.prReviews) {
  if (review.status !== 'running') continue;
  review.status = 'error';
  review.messages.push({ id: randomUUID(), role: 'assistant', text: 'The server restarted before this simulated review completed. Start a new review to try again.', sentAt: new Date().toISOString() });
}
const autoSaveDelay = Number(process.env.CHAT_AUTOSAVE_MS || 30000);
state.taskDelaySeconds = Math.ceil(autoSaveDelay / 1000);
const recipients = message => message.to === 'group' ? ['Aryan', 'Noel', 'Kiran'].filter(name => name !== message.from) : [message.to];
let pool;
let store;
if (verificationMode === 'real') {
  try {
    const databaseUrl = new URL(process.env.VERIFICATION_DATABASE_URL);
    const workspaceId = process.env.VERIFICATION_WORKSPACE_ID;
    const backendUrl = new URL(process.env.VERIFICATION_BACKEND_URL);
    const backendToken = process.env.VERIFICATION_BACKEND_TOKEN;
    if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol) || !databaseUrl.hostname
      || typeof workspaceId !== 'string' || !workspaceId.trim() || workspaceId.length > 200 || /[\x00-\x1f\x7f]/.test(workspaceId)
      || !['http:', 'https:'].includes(backendUrl.protocol) || backendUrl.username || backendUrl.password
      || /[?#@]/.test(process.env.VERIFICATION_BACKEND_URL) || backendUrl.pathname !== '/'
      || (backendUrl.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(backendUrl.hostname))
      || !/^[A-Za-z0-9_-]{32,256}$/.test(backendToken ?? '')) throw new Error('Invalid configuration');
    const [{ createDatabase, migrate }, { IntegrationContextStore }] = await Promise.all([
      import('./backend/dist/database.js'), import('./backend/dist/integration-context.js')
    ]);
    pool = createDatabase(databaseUrl.href);
    pool.on('error', () => console.error('Real verification database connection unavailable.'));
    await migrate(pool);
    const identity = createHash('sha256').update(JSON.stringify([backendUrl.origin, backendToken])).digest('hex');
    store = new IntegrationContextStore(pool, workspaceId, identity);
    await store.snapshot();
  } catch {
    if (pool) await pool.end().catch(() => {});
    pool = undefined;
    store = undefined;
    console.error('Real verification store unavailable. Check explicit configuration and compiled backend artifacts.');
  }
}
const verification = createBackendAdapter(process.env, {
  store,
  getContext: () => ({ sender: 'Aryan', recipient: 'Noel', contractSnapshot: structuredClone({
    contractVersion: state.contractVersion, assignment: state.assignment, requirements: state.requirements
  }) }),
  onUpdate: async snapshot => {
    if (snapshot.revision <= (state.verification?.revision ?? -1)) return;
    state.verification = snapshot;
    await publish();
  }
});
// Saved rehearsal results cannot represent real verification or delivery authority.
if (verification.mode === 'real') { state.run = null; state.handoff = null; }
if (state.run?.status === 'running') { state.run.status = 'unverified'; state.run.error = 'The server restarted before verification completed. Run it again.'; }
const clients = new Set();
let persistence = Promise.resolve();
state.sequence = Number.isSafeInteger(state.sequence) && state.sequence >= 0 ? state.sequence : 0;
// The database, not a possibly stale JSON mirror, owns real verification context.
if (verification.mode === 'real') state.verification = { revision: 0, runs: [] };
async function publish() {
  state.sequence++;
  const snapshot = JSON.stringify(state);
  persistence = persistence.catch(() => {}).then(async () => {
    const temporary = `${stateFile}.tmp`;
    await writeFile(temporary, snapshot);
    await rename(temporary, stateFile);
    for (const client of clients) client.write(`data: ${snapshot}\n\n`);
  });
  await persistence;
}
async function sendState(res, events = false) {
  // Drain through the latest publication before exposing its durable sequence.
  let current;
  do { current = persistence; await current; } while (current !== persistence);
  const snapshot = JSON.stringify(state);
  if (events) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${snapshot}\n\n`);
    clients.add(res);
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(snapshot);
  }
}
async function captureMissedIdeas() {
  let changed = false;
  for (const message of state.messages) {
    if (message.kind !== 'recommendation' || !message.autoSaveAt || Date.now() < message.autoSaveAt) continue;
    for (const owner of recipients(message)) {
      const day = state.daily[owner];
      if (!state.taskPreferences[owner] || state.taskDismissed.includes(`${owner}:${message.id}`) || day.tasks.some(task => task.messageId === message.id)) continue;
      day.tasks.push({ id: `chat-${message.id}`, messageId: message.id, title: message.title, description: message.text, source: message.from, conversation: message.to === 'group' ? 'group' : message.from, completed: false, addedBy: 'auto' });
      day.version++;
      changed = true;
    }
  }
  if (changed) await publish();
}
setInterval(() => captureMissedIdeas().catch(error => console.error('Task auto-add failed:', error.message)), 1000).unref();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const demoFindings = {
  42: { severity: 'high', file: 'src/checkout.js', line: 38, title: 'Restore checkout after a declined payment', body: 'The simulated declined-payment branch leaves the checkout action disabled. Clear the pending state and display PAYMENT_DECLINED so the customer can retry.' },
  43: { severity: 'high', file: 'api/checkout.js', line: 27, title: 'Keep the declined response shape consistent', body: 'The simulated error response omits the agreed PAYMENT_DECLINED code. Return that code with an actionable message, and keep orderId on successful responses.' },
  44: { severity: 'medium', file: 'tests/checkout.spec.js', line: 52, title: 'Assert the retry action at mobile width', body: 'The simulated mobile test does not check the declined-payment retry action at 375px. Assert that the error and enabled checkout button are visible without horizontal overflow.' }
};
async function simulatePrReview(review) {
  try {
    for (let step = 1; step <= 4; step++) {
      await wait(450);
      review.step = step;
      if (step === 4) {
        review.status = 'completed';
        review.findings = review.fixed ? [] : [structuredClone(demoFindings[review.prNumber])];
        review.messages.push({ id: randomUUID(), role: 'assistant', text: review.fixed
          ? `Simulated re-review of PR #${review.prNumber} at ${review.headSha} completed with no findings. No real code was changed or tested. Task completion and verification are unchanged.`
          : `Simulated review of PR #${review.prNumber} at ${review.headSha} found: ${review.findings[0].title}. Ask why, how to fix it, what tests to add, or about scope. This is fixture feedback, not a real code review.`, sentAt: new Date().toISOString() });
      }
      await publish();
    }
  } catch {
    review.status = 'error';
    review.messages.push({ id: randomUUID(), role: 'assistant', text: 'The simulated review could not complete. Start a new review to try again.', sentAt: new Date().toISOString() });
    await publish().catch(() => console.error('Unable to persist simulated PR review failure.'));
  }
}
async function simulate(run) {
  for (let step = 1; step <= 5; step++) {
    await wait(1400);
    run.step = step;
    await publish();
  }
  run.results = run.requirements.map(req => ({ id: req.id, outcome: req.id === 'declined' && !run.fixed ? 'Failed' : 'Passed' }));
  run.status = run.fixed ? 'passed' : 'failed';
  run.finishedAt = new Date().toISOString();
  if (run.fixed) state.handoff = { ...structuredClone(run), acknowledged: false };
  await publish();
}
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  try {
    if (!verification.protect(req, res)) return;
    const url = new URL(req.url, 'http://localhost');
    if (await verification.handle(req, res, url)) return;
    if (url.pathname === '/api/events') {
      await sendState(res, true);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/api/state' && req.method === 'GET') {
      await sendState(res); return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 20000) { res.writeHead(413); res.end(); return; } }
      const input = body ? JSON.parse(body) : {};
      if (state.run?.status === 'running' && ['/api/verify', '/api/fix', '/api/contract'].includes(url.pathname)) {
        res.writeHead(409); res.end(JSON.stringify({ error: 'Wait for the active verification to finish.' })); return;
      }
      if (['/api/github-connect', '/api/pr-review', '/api/pr-review-chat', '/api/pr-review-fix'].includes(url.pathname)) {
        const allowed = {
          '/api/github-connect': ['owner'], '/api/pr-review': ['owner', 'taskId', 'prNumber'],
          '/api/pr-review-chat': ['owner', 'reviewId', 'text'], '/api/pr-review-fix': ['owner', 'reviewId']
        }[url.pathname];
        const fail = (status, error) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error })); };
        if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some(key => !allowed.includes(key)) || typeof input.owner !== 'string' || !Object.hasOwn(demoLogins, input.owner)) {
          fail(400, 'Choose a valid demo owner and use only the documented fields.'); return;
        }
        if (url.pathname === '/api/github-connect') {
          state.github.accounts[input.owner] = { login: demoLogins[input.owner] };
          await publish();
        } else {
          if (!Object.hasOwn(state.github.accounts, input.owner)) { fail(409, 'Connect the demo GitHub account first.'); return; }
          let prior;
          if (url.pathname !== '/api/pr-review') {
            prior = state.prReviews.find(review => review.id === input.reviewId);
            if (!prior) { fail(404, 'Review not found.'); return; }
            if (prior.owner !== input.owner) { fail(403, 'This review belongs to another owner.'); return; }
            if (prior.status !== 'completed') { fail(409, 'Wait for a completed review.'); return; }
          }
          if (url.pathname === '/api/pr-review-chat') {
            if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000) { fail(400, 'Enter a review question of 1 to 2000 characters.'); return; }
            const text = input.text.trim();
            const question = text.toLowerCase();
            const finding = demoFindings[prior.prNumber];
            let reply;
            if (/\b(scope|files?|sha|task)\b/.test(question)) reply = `This simulated review covers only PR #${prior.prNumber}, ${prior.headSha}, ${finding.file}, and the captured task "${prior.taskSnapshot.title}" (${prior.taskId}). It does not verify the whole repository or mark tasks complete.`;
            else if (/\b(tests?|testing)\b/.test(question)) reply = `Suggested fixture regression test: ${prior.prNumber === 42 ? 'decline the first payment, assert the error and enabled action, then retry successfully' : prior.prNumber === 43 ? 'assert orderId on success and PAYMENT_DECLINED with a message on failure' : 'at 375px, decline a payment and assert the error and enabled retry button are visible with no horizontal overflow'}. No tests were actually executed.`;
            else if (/\b(fix|resolve|repair)\b/.test(question)) reply = `${finding.body} The explicit simulated fix action creates a new mock SHA and re-review; chatting does not modify code.`;
            else if (/\b(why|explain|reason)\b/.test(question)) reply = prior.fixed ? 'The simulated fix fixture has no remaining findings. This is not evidence that real code is correct.' : `${finding.title}: ${finding.body} This finding is predefined fixture feedback, not an inspection of real code.`;
            else reply = 'This is a deterministic PR-review demo, not general AI. Ask about why this finding matters, the suggested fix, tests, or review scope. I cannot execute commands, open URLs, or review other code.';
            prior.messages.push({ id: randomUUID(), role: 'user', text, sentAt: new Date().toISOString() }, { id: randomUUID(), role: 'assistant', text: reply, sentAt: new Date().toISOString() });
            await publish();
          } else {
            const taskId = prior ? prior.taskId : input.taskId;
            const prNumber = prior ? prior.prNumber : input.prNumber;
            const task = state.daily[input.owner].tasks.find(task => task.id === taskId);
            const pr = state.github.prs.find(pr => pr.number === prNumber && Object.hasOwn(demoFindings, pr.number));
            if (!task || !pr) { fail(400, 'Choose an existing owner task and fixture PR number (42, 43, or 44).'); return; }
            if (state.prReviews.some(review => review.taskId === taskId && review.prNumber === prNumber && review.status === 'running')) {
              fail(409, 'A review for this task and PR is already running.'); return;
            }
            const review = {
              owner: input.owner, taskId, prNumber, headSha: prior ? `demo-pr-${prNumber}-fix-${randomUUID()}` : pr.headSha,
              id: randomUUID(), status: 'running', step: 0, findings: [], messages: [], fixed: Boolean(prior),
              taskSnapshot: structuredClone(task)
            };
            state.prReviews.push(review);
            if (prior) pr.headSha = review.headSha;
            await publish();
            void simulatePrReview(review);
          }
        }
      } else if (['/api/task', '/api/create-task', '/api/add-task', '/api/remove-task', '/api/send'].includes(url.pathname)) {
        const day = state.daily[input.from];
        if (!['Aryan', 'Noel', 'Kiran'].includes(input.from)) { res.writeHead(400); res.end(JSON.stringify({ error: 'Choose a valid teammate view.' })); return; }
        if (url.pathname === '/api/create-task') {
          if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 120 || typeof input.description !== 'string' || input.description.length > 1000) { res.writeHead(400); res.end(JSON.stringify({ error: 'Enter a task title (up to 120 characters) and optional details (up to 1000 characters).' })); return; }
          const dueDate = input.dueDate ?? '', dueTime = input.dueTime ?? '';
          if (typeof dueDate !== 'string' || typeof dueTime !== 'string' || Boolean(dueDate) !== Boolean(dueTime) || dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(Date.parse(dueDate)) || new Date(dueDate).toISOString().slice(0, 10) !== dueDate || !/^([01]\d|2[0-3]):[0-5]\d$/.test(dueTime))) { res.writeHead(400); res.end(JSON.stringify({ error: 'Set a valid due date and time together, or leave both empty.' })); return; }
          day.tasks.push({ id: `custom-${randomUUID()}`, title: input.title.trim(), description: input.description.trim(), completed: false, addedBy: 'manual', createdBy: input.from, dueDate: dueDate || null, dueTime: dueTime || null });
          day.version++;
        } else if (url.pathname === '/api/task') {
          const task = day.tasks.find(task => task.id === input.id);
          if (!task || typeof input.completed !== 'boolean') { res.writeHead(400); res.end(JSON.stringify({ error: 'Choose a valid task.' })); return; }
          task.completed = input.completed; day.version++;
        } else if (url.pathname === '/api/add-task') {
          const recommendation = day.recommendations.find(task => task.id === input.id);
          if (!recommendation) { res.writeHead(404); res.end(JSON.stringify({ error: 'Recommendation not found.' })); return; }
          if (!day.tasks.some(task => task.id === input.id)) {
            const { reason, ...task } = recommendation;
            day.tasks.push({ ...task, completed: false, addedBy: 'manual' }); day.version++;
          }
        } else if (url.pathname === '/api/remove-task') {
          const task = day.tasks.find(task => task.id === input.id);
          if (!task) { res.writeHead(404); res.end(JSON.stringify({ error: 'Task not found.' })); return; }
          day.tasks = day.tasks.filter(item => item.id !== task.id); day.version++;
          if (task.messageId) {
            const key = `${input.from}:${task.messageId}`;
            if (!state.taskDismissed.includes(key)) state.taskDismissed.push(key);
          }
          if (task.id.startsWith('teammate-')) {
            const key = `${input.from}:${task.id}`;
            if (!state.deletedSeedTasks.includes(key)) state.deletedSeedTasks.push(key);
          }
        } else {
          if (!['Aryan', 'Noel', 'Kiran'].includes(input.to) || input.to === input.from) { res.writeHead(400); res.end(JSON.stringify({ error: 'Choose another teammate.' })); return; }
          if (input.version !== day.version || !day.tasks.length || day.tasks.some(task => !task.completed)) { res.writeHead(409); res.end(JSON.stringify({ error: 'Complete all current tasks before sending.' })); return; }
          if (!state.deliveries.some(delivery => delivery.from === input.from && delivery.to === input.to && delivery.version === day.version)) {
            state.deliveries.unshift({ id: randomUUID(), from: input.from, to: input.to, version: day.version, tasks: structuredClone(day.tasks), sentAt: new Date().toISOString(), contractVersion: state.contractVersion });
          }
        }
        await publish();
      } else if (url.pathname === '/api/chat') {
        if (!['Aryan', 'Noel', 'Kiran'].includes(input.from) || !['Aryan', 'Noel', 'Kiran', 'group'].includes(input.to) || input.from === input.to || !['message', 'recommendation'].includes(input.kind) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000 || input.kind === 'recommendation' && (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 120)) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'Choose a teammate and enter a message. Recommendations also need a short task title.' })); return;
        }
        const message = { id: randomUUID(), from: input.from, to: input.to, text: input.text.trim(), kind: input.kind, sentAt: new Date().toISOString() };
        if (input.kind === 'recommendation') {
          message.title = input.title.trim();
          message.autoSaveAt = Date.now() + autoSaveDelay;
          for (const owner of recipients(message)) state.daily[owner].recommendations.unshift({ id: `chat-${message.id}`, title: message.title, description: message.text, reason: 'Suggested in teammate chat. Add it to your plan when you are ready.', source: input.from, messageId: message.id, conversation: input.to === 'group' ? 'group' : input.from });
        }
        state.messages.push(message);
        await publish();
      } else if (url.pathname === '/api/chat-read') {
        if (!['Aryan', 'Noel', 'Kiran'].includes(input.owner) || !['Aryan', 'Noel', 'Kiran', 'group'].includes(input.peer) || input.owner === input.peer) { res.writeHead(400); res.end(JSON.stringify({ error: 'Choose a valid conversation.' })); return; }
        const latest = state.messages.filter(m => m.from !== input.owner && (input.peer === 'group' ? m.to === 'group' : m.from === input.peer && m.to === input.owner)).at(-1);
        const key = `${input.owner}:${input.peer}`;
        if (latest && state.chatReadAt[key] !== latest.sentAt) { state.chatReadAt[key] = latest.sentAt; await publish(); }
      } else if (url.pathname === '/api/task-preferences') {
        if (!['Aryan', 'Noel', 'Kiran'].includes(input.owner) || typeof input.enabled !== 'boolean') { res.writeHead(400); res.end(JSON.stringify({ error: 'Choose a valid task preference.' })); return; }
        state.taskPreferences[input.owner] = input.enabled;
        await publish();
      } else if (url.pathname === '/api/calendar') {
        const message = state.messages.find(m => m.id === input.messageId);
        if (!['Aryan', 'Noel', 'Kiran'].includes(input.owner) || !message || message.kind !== 'recommendation' || !recipients(message).includes(input.owner) || typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date) || Number.isNaN(Date.parse(input.date)) || new Date(input.date).toISOString().slice(0, 10) !== input.date) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'Choose a valid task idea and calendar date.' })); return;
        }
        const existing = state.calendar.find(entry => entry.owner === input.owner && entry.messageId === message.id);
        if (existing) { existing.date = input.date; existing.addedBy = 'manual'; }
        else state.calendar.push({ id: randomUUID(), owner: input.owner, messageId: message.id, title: message.title, description: message.text, source: message.from, date: input.date, addedBy: 'manual', createdAt: new Date().toISOString() });
        state.calendarDismissed = state.calendarDismissed.filter(id => id !== `${input.owner}:${message.id}`);
        await publish();
      } else if (url.pathname === '/api/calendar-remove') {
        const entry = state.calendar.find(entry => entry.id === input.id && entry.owner === input.owner);
        if (!entry) { res.writeHead(404); res.end(JSON.stringify({ error: 'Calendar item not found.' })); return; }
        state.calendar = state.calendar.filter(item => item.id !== entry.id);
        if (!state.calendarDismissed.includes(`${entry.owner}:${entry.messageId}`)) state.calendarDismissed.push(`${entry.owner}:${entry.messageId}`);
        await publish();
      } else if (url.pathname === '/api/verify') {
        const run = { id: Date.now().toString(36), status: 'running', step: 0, fixed: state.fixed, revision: state.fixed ? 'demo-fix-002' : 'demo-ui-001', contractVersion: state.contractVersion, requirements: structuredClone(state.requirements), startedAt: new Date().toISOString(), results: [] };
        state.run = run;
        await publish();
        simulate(run).catch(async error => { run.status = 'unverified'; run.error = error.message; await publish(); });
      } else if (url.pathname === '/api/fix') { state.fixed = !state.fixed; await publish(); }
      else if (url.pathname === '/api/contract') {
        if (input.contractVersion !== state.contractVersion) { res.writeHead(409); res.end(JSON.stringify({ error: 'The contract changed in another view. Reopen the editor.' })); return; }
        if (typeof input.assignment !== 'string' || !input.assignment.trim() || input.assignment.length > 120 || !Array.isArray(input.requirements) || input.requirements.length !== 4 || input.requirements.some((r, i) => r.id !== initial.requirements[i].id || ['name', 'promise', 'verify'].some(key => typeof r[key] !== 'string' || !r[key].trim() || r[key].length > 1000))) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'Enter a deliverable and complete all requirement fields.' })); return;
        }
        state.assignment = input.assignment.trim(); state.requirements = input.requirements; state.contractVersion++; await publish();
      } else if (url.pathname === '/api/acknowledge') { if (state.handoff) state.handoff.acknowledged = true; await publish(); }
      else { res.writeHead(404); res.end(); return; }
      await sendState(res); return;
    }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    const file = url.pathname === '/' ? 'landing.html' : ['/tasks', '/tasks/'].includes(url.pathname) ? 'index.html' : url.pathname.slice(1);
    const resolved = path.resolve(root, 'public', file);
    if (!resolved.startsWith(path.join(root, 'public') + path.sep)) { res.writeHead(403); res.end(); return; }
    const data = await readFile(resolved);
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); res.end(data);
  } catch (error) { if (!res.headersSent && !res.destroyed) { res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end('Unable to complete request.'); } }
});
await publish();
await verification.start();
server.listen(process.env.PORT || 5173, verification.mode === 'real' ? '127.0.0.1' : (process.env.HOST || '0.0.0.0'), () => console.log(`Relay listening on port ${server.address().port}`));
setInterval(() => { for (const client of clients) client.write(': heartbeat\n\n'); }, 20000).unref();
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => process.exit(1), 12000);
  deadline.unref();
  const closed = new Promise(resolve => server.close(resolve));
  for (const client of clients) client.end();
  server.closeIdleConnections();
  await verification.stop();
  await closed;
  await persistence;
  if (pool) await pool.end();
  clearTimeout(deadline);
  process.exit(0);
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => shutdown().catch(() => process.exit(1)));
