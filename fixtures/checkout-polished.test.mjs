import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

async function startServer(t, directory) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: fileURLToPath(new URL(directory, import.meta.url)),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.kill('SIGTERM');
    try { await closed; } finally { clearTimeout(timer); }
  });
  let output = '';
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Startup timed out: ${output}${errors}`)), 10000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/listening on (http:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Early exit ${code}: ${errors}`)); });
  });
}

test('broken polished fixture differs only in the intentional catch regression', async () => {
  const fixed = await readFile(new URL('./checkout/index.html', import.meta.url), 'utf8');
  const broken = await readFile(new URL('./checkout-broken/index.html', import.meta.url));
  const catchBody = '        error.textContent = failure.message;\n        error.hidden = false;\n        retry.hidden = false;';
  assert.ok(fixed.includes(catchBody));
  const expected = fixed.replace(catchBody,
    '        // Intentional demo regression: a declined payment blanks the checkout.\n        checkout.replaceChildren();');
  assert.equal(Buffer.compare(broken, Buffer.from(expected)), 0);
  assert.equal(Buffer.compare(
    await readFile(new URL('./checkout/server.js', import.meta.url)),
    await readFile(new URL('./checkout-broken/server.js', import.meta.url)),
  ), 0);
});

test('polished working-tree checkouts match initially and diverge after real declines', { timeout: 60000 }, async (t) => {
  const fixedURL = await startServer(t, './checkout/');
  const brokenURL = await startServer(t, './checkout-broken/');
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1, reducedMotion: 'reduce',
  });
  const screenshots = [];
  const pages = [];
  const pageErrors = [];
  for (const url of [fixedURL, brokenURL]) {
    const page = await context.newPage();
    pages.push(page);
    page.on('pageerror', error => pageErrors.push(error.message));
    const response = await page.goto(url);
    assert.equal(response.status(), 200);
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveTitle('Checkout | Paper / Field');
    await expect(page.locator('.wordmark')).toHaveText('PAPER / FIELD');
    await expect(page.getByRole('heading', { name: 'Checkout', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'The Everyday Notebook' })).toBeVisible();
    await expect(page.getByTestId('error')).toBeHidden();
    await expect(page.getByTestId('retry')).toBeHidden();
    await expect(page.getByTestId('loading')).toBeHidden();
    screenshots.push(await page.screenshot({ fullPage: true, animations: 'disabled' }));
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => Math.max(
      document.documentElement.scrollWidth, document.body.scrollWidth,
    ) <= window.innerWidth), true, `${url} overflows at 375px`);
    await expect(page.getByTestId('submit')).toBeVisible();
    await expect(page.getByTestId('cart')).toBeVisible();
  }
  assert.equal(Buffer.compare(screenshots[0], screenshots[1]), 0, 'Initial desktop screenshots must be identical');

  for (const [index, page] of pages.entries()) {
    let posts = 0;
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/checkout') posts++;
    });
    const decline = page.waitForResponse(response =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/checkout');
    await page.getByTestId('submit').click();
    const response = await decline;
    assert.equal(response.status(), 402);
    assert.deepEqual(await response.json(), {
      code: 'PAYMENT_DECLINED', message: 'Payment declined. Please try again.',
    });
    assert.equal(posts, 1);
    if (index === 1) {
      await expect(page.getByTestId('checkout')).toBeEmpty();
      assert.equal(await page.getByTestId('checkout').innerHTML(), '');
      await expect(page.getByTestId('error')).toHaveCount(0);
      await expect(page.getByTestId('retry')).toHaveCount(0);
      continue;
    }
    await expect(page.getByTestId('error')).toHaveText('Payment declined. Please try again.');
    await expect(page.getByTestId('error')).toBeVisible();
    await expect(page.getByTestId('error')).toBeFocused();
    await expect(page.getByTestId('retry')).toBeVisible();
    await expect(page.getByTestId('retry')).toBeEnabled();
    await expect(page.getByTestId('submit')).toBeEnabled();
    await expect(page.getByTestId('cart')).toBeVisible();
    const retried = page.waitForResponse(response =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/checkout');
    await page.getByTestId('retry').click();
    const retryResponse = await retried;
    assert.equal(retryResponse.status(), 402);
    assert.deepEqual(await retryResponse.json(), {
      code: 'PAYMENT_DECLINED', message: 'Payment declined. Please try again.',
    });
    assert.equal(posts, 2, 'Retry must send a new real POST');
    await expect(page.getByTestId('error')).toHaveText('Payment declined. Please try again.');
    await expect(page.getByTestId('error')).toBeVisible();
    await expect(page.getByTestId('retry')).toBeEnabled();
    await expect(page.getByTestId('loading')).toBeHidden();
  }
  assert.deepEqual(pageErrors, []);
});
