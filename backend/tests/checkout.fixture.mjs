import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = JSON.parse(await readFile(resolve(root, 'fixtures/checkout-revisions.json'), 'utf8'));
const repository = resolve(root, fixture.repositoryPath);

for (const [revision, sha] of Object.entries(fixture.revisions)) {
  test(`${revision} checkout at immutable commit ${sha}`, { timeout: 30000 }, async (t) => {
    assert.match(sha, /^[a-f0-9]{40}$/);
    const commit = spawnSync('git', ['rev-parse', `${sha}^{commit}`], { cwd: repository, encoding: 'utf8' });
    assert.equal(commit.status, 0, commit.stderr);
    assert.equal(commit.stdout.trim(), sha);
    assert.equal((await stat('/tmp/opencode')).isDirectory(), true);
    const directory = await mkdtemp('/tmp/opencode/checkout-fixture-');
    t.after(() => rm(directory, { recursive: true, force: true }));
    const archive = spawnSync('git', ['archive', '--format=tar', sha], { cwd: repository });
    assert.equal(archive.status, 0, archive.stderr.toString());
    const extract = spawnSync('tar', ['-xf', '-', '-C', directory], { input: archive.stdout });
    assert.equal(extract.status, 0, extract.stderr.toString());
    assert.equal(fixture.setupCommand, 'npm run setup');
    const setup = spawnSync('npm', ['run', 'setup'], { cwd: directory, encoding: 'utf8', timeout: 10000 });
    assert.equal(setup.status, 0, setup.stdout + setup.stderr);

    assert.equal(fixture.startCommand, 'node server.js');
    const server = spawn(process.execPath, ['server.js'], {
      cwd: directory,
      env: { ...process.env, HOST: fixture.host, PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(async () => {
      if (server.exitCode !== null || server.signalCode !== null) return;
      const exited = once(server, 'exit');
      server.kill('SIGKILL');
      await exited;
    });
    const address = await new Promise((resolveAddress, reject) => {
      let output = '';
      let errors = '';
      const timer = setTimeout(() => reject(new Error(`Fixture startup timed out: ${output}${errors}`)), 5000);
      server.stderr.on('data', chunk => { errors += chunk; });
      server.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/listening on (http:\/\/[^\s]+)/);
        if (match) {
          clearTimeout(timer);
          resolveAddress(match[1]);
        }
      });
      server.once('error', error => { clearTimeout(timer); reject(error); });
      server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${errors}`)); });
    });

    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const contract = fixture.declinedPayment;
    const response = await page.request.post(`${address}${contract.path}`);
    assert.equal(response.status(), contract.status);
    assert.deepEqual(await response.json(), contract.body);
    await page.goto(`${address}${fixture.readyPath}`);
    const selectors = fixture.selectors;
    const cart = await page.locator(selectors.cart).textContent();
    await expect(page.locator(selectors.error)).toBeHidden();
    await expect(page.locator(selectors.retry)).toBeHidden();

    // Hold the real request briefly to assert the in-flight UI without timing races.
    let release;
    const gate = new Promise(resolveGate => { release = resolveGate; });
    await page.route('**/checkout', async route => { await gate; await route.continue(); }, { times: 1 });
    const declined = page.waitForResponse(result => result.url() === `${address}${contract.path}` && result.request().method() === 'POST');
    await page.locator(selectors.submit).click();
    try {
      await expect(page.locator(selectors.loading)).toBeVisible();
      await expect(page.locator(selectors.submit)).toBeDisabled();
    } finally {
      release();
    }
    assert.equal((await declined).status(), contract.status);

    if (revision === 'broken') {
      await expect(page.locator(selectors.checkout)).toBeEmpty();
      await expect(page.locator(selectors.error)).toHaveCount(0);
      await expect(page.locator(selectors.retry)).toHaveCount(0);
    } else {
      await expect(page.locator(selectors.error)).toBeVisible();
      await expect(page.locator(selectors.error)).toHaveText(contract.body.message);
      await expect(page.locator(selectors.retry)).toBeVisible();
      await expect(page.locator(selectors.retry)).toBeEnabled();
      await expect(page.locator(selectors.loading)).toBeHidden();
      await expect(page.locator(selectors.cart)).toHaveText(cart);
      const retried = page.waitForResponse(result => result.url() === `${address}${contract.path}` && result.request().method() === 'POST');
      await page.locator(selectors.retry).click();
      const retryResponse = await retried;
      assert.equal(retryResponse.status(), contract.status);
      assert.deepEqual(await retryResponse.json(), contract.body);
      await expect(page.locator(selectors.error)).toBeVisible();
      await expect(page.locator(selectors.error)).toHaveText(contract.body.message);
      await expect(page.locator(selectors.retry)).toBeEnabled();
      await expect(page.locator(selectors.submit)).toBeEnabled();
      await expect(page.locator(selectors.loading)).toBeHidden();
      await expect(page.locator(selectors.cart)).toHaveText(cart);
    }
    assert.deepEqual(pageErrors, []);
  });
}
