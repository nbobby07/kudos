import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = JSON.parse(await readFile(new URL('./checkout-revisions.json', import.meta.url), 'utf8'));

test('demo launcher rejects an unknown scenario', () => {
  const result = spawnSync(process.execPath, ['fixtures/checkout-demo.mjs', 'unknown'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
});

for (const scenario of ['broken', 'fixed']) {
  test(`demo launcher serves pinned ${scenario} revision and stops cleanly`, { timeout: 20000 }, async (t) => {
    const child = spawn(process.execPath, ['fixtures/checkout-demo.mjs', scenario], {
      cwd: root, env: { ...process.env, DEMO_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    });
    const closed = once(child, 'close');
    let output = '';
    let errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    const address = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Startup timed out: ${output}${errors}`)), 10000);
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/listening on (http:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Early exit ${code}: ${errors}`)); });
    });
    assert.ok(output.includes(fixture.revisions[scenario]));
    const page = await fetch(address);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /data-testid="submit"/);
    const decline = await fetch(`${address}/checkout`, { method: 'POST' });
    assert.equal(decline.status, fixture.declinedPayment.status);
    assert.deepEqual(await decline.json(), fixture.declinedPayment.body);
    child.kill('SIGTERM');
    const [code] = await closed;
    assert.equal(code, 0, errors);
  });
}
