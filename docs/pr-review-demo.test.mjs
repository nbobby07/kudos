import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('demo PR review API, scoped chat, explicit fix, persistence and restart recovery', { timeout: 20000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'relay-pr-review-'));
  let child;
  let base;
  async function start() {
    child = spawn(process.execPath, ['server.js'], {
      cwd: new URL('../', import.meta.url),
      env: { ...process.env, VERIFICATION_MODE: 'simulation', DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 5000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
      child.stderr.on('data', chunk => { output += chunk; });
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/Relay listening on port (\d+)/);
        if (match) { clearTimeout(timer); base = `http://127.0.0.1:${match[1]}`; resolve(); }
      });
    });
  }
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  t.after(async () => { await stop(); await rm(dataDir, { recursive: true, force: true }); });
  await start();
  const get = async () => (await fetch(`${base}/api/state`)).json();
  async function post(route, body, status = 200) {
    const response = await fetch(`${base}/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, status);
    const snapshot = await response.json();
    if (status === 200) assert.ok(snapshot.daily && snapshot.github && snapshot.prReviews);
    else assert.equal(typeof snapshot.error, 'string');
    return snapshot;
  }
  async function completed(id) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const snapshot = await get();
      const review = snapshot.prReviews.find(review => review.id === id);
      if (review.status === 'completed') return { snapshot, review };
      assert.equal(review.status, 'running');
      await delay(50);
    }
    assert.fail('Review did not complete');
  }
  const initial = await get();
  assert.deepEqual(initial.github.accounts, {});
  assert.equal(initial.github.repository, 'checkout-team/checkout');
  assert.deepEqual(initial.github.prs.map(pr => pr.number), [42, 43, 44]);
  assert.deepEqual(initial.prReviews, []);
  await post('github-connect', { owner: 'Unknown' }, 400);
  await post('github-connect', { owner: ['Aryan'] }, 400);
  await post('github-connect', { owner: 'Aryan', url: 'https://example.com' }, 400);
  await post('pr-review', { owner: 'Aryan', taskId: 'declined', prNumber: 42 }, 409);
  for (const owner of ['Aryan', 'Noel', 'Kiran']) {
    const snapshot = await post('github-connect', { owner });
    assert.equal(snapshot.github.accounts[owner].login, `${owner.toLowerCase()}-checkout`);
  }
  await post('pr-review', { owner: 'Aryan', taskId: 'missing', prNumber: 42 }, 400);
  await post('pr-review', { owner: 'Aryan', taskId: 'declined', prNumber: '42' }, 400);
  await post('pr-review', { owner: 'Aryan', taskId: 'declined', prNumber: 45 }, 400);
  const started = [];
  for (const [owner, taskId, prNumber] of [['Aryan', 'declined', 42], ['Noel', 'responses', 43], ['Kiran', 'test-plan', 44]]) {
    const snapshot = await post('pr-review', { owner, taskId, prNumber });
    const review = snapshot.prReviews.at(-1);
    assert.equal(review.status, 'running');
    assert.equal(review.step, 0);
    assert.deepEqual(review.findings, []);
    assert.deepEqual(review.messages, []);
    assert.equal(review.fixed, false);
    assert.deepEqual(review.taskSnapshot, snapshot.daily[owner].tasks.find(task => task.id === taskId));
    started.push(review);
  }
  const first = started[0];
  await post('pr-review', { owner: 'Aryan', taskId: 'declined', prNumber: 42 }, 409);
  await post('pr-review-chat', { owner: 'Aryan', reviewId: first.id, text: 'why' }, 409);
  await post('pr-review-fix', { owner: 'Aryan', reviewId: first.id }, 409);
  // Changing the live task must not change the captured review task.
  await post('task', { from: 'Aryan', id: 'declined', completed: true });
  for (const review of started) {
    const result = await completed(review.id);
    assert.equal(result.review.step, 4);
    assert.equal(result.review.findings.length, 1);
    assert.equal(result.review.findings[0].file, initial.github.prs.find(pr => pr.number === review.prNumber).files[0]);
    assert.equal(result.review.messages[0].role, 'assistant');
  }
  await post('pr-review-chat', { owner: 'Noel', reviewId: first.id, text: 'why' }, 403);
  await post('pr-review-chat', { owner: 'Aryan', reviewId: 'missing', text: 'why' }, 404);
  for (const text of ['', ' ', 'x'.repeat(2001)]) await post('pr-review-chat', { owner: 'Aryan', reviewId: first.id, text }, 400);
  for (const [text, expected] of [['why', /declined/i], ['fix', /explicit simulated fix/i], ['tests', /retry successfully/i], ['scope', /src\/checkout.js/], ['tell me a joke', /not general AI/i]]) {
    const snapshot = await post('pr-review-chat', { owner: 'Aryan', reviewId: first.id, text });
    const messages = snapshot.prReviews.find(review => review.id === first.id).messages;
    assert.equal(messages.at(-2).role, 'user');
    assert.match(messages.at(-1).text, expected);
  }
  const beforeFix = await get();
  const prior = beforeFix.prReviews.find(review => review.id === first.id);
  assert.equal(prior.taskSnapshot.completed, false);
  const fixing = await post('pr-review-fix', { owner: 'Aryan', reviewId: first.id });
  const fixed = fixing.prReviews.at(-1);
  assert.notEqual(fixed.id, first.id);
  assert.notEqual(fixed.headSha, first.headSha);
  assert.equal(fixed.fixed, true);
  assert.equal(fixing.github.prs[0].headSha, fixed.headSha);
  assert.deepEqual(fixing.prReviews.find(review => review.id === first.id), prior);
  await post('pr-review-fix', { owner: 'Aryan', reviewId: first.id }, 409);
  const result = await completed(fixed.id);
  assert.deepEqual(result.review.findings, []);
  assert.deepEqual(result.snapshot.daily, beforeFix.daily);
  for (const key of ['fixed', 'run', 'handoff', 'verification']) assert.deepEqual(result.snapshot[key], beforeFix[key]);
  const pending = (await post('pr-review', { owner: 'Noel', taskId: 'responses', prNumber: 43 })).prReviews.at(-1);
  await stop();
  await start();
  const restarted = await get();
  const interrupted = restarted.prReviews.find(review => review.id === pending.id);
  assert.equal(interrupted.status, 'error');
  assert.match(interrupted.messages.at(-1).text, /restarted/i);
  assert.deepEqual(restarted.prReviews.find(review => review.id === first.id), prior);
  assert.equal(restarted.prReviews.find(review => review.id === fixed.id).status, 'completed');
  await post('pr-review', { owner: 'Noel', taskId: 'responses', prNumber: 43 });
});
