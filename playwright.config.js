import { defineConfig } from '@playwright/test';
import { createServer } from 'node:net';

// Workers reload this config, so inherit the parent's selected test port.
if (!process.env.RELAY_TEST_PORT) {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  process.env.RELAY_TEST_PORT = String(probe.address().port);
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
}
const port = Number(process.env.RELAY_TEST_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid RELAY_TEST_PORT');
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests',
  testMatch: 'handoff.spec.js',
  workers: 1,
  timeout: 30000,
  use: { baseURL, browserName: 'chromium' },
  webServer: {
    command: 'npm run build:chat && node server.js',
    env: { PORT: String(port), DATA_DIR: `/tmp/opencode/relay-tests-${Date.now()}`, CHAT_AUTOSAVE_MS: '2000' },
    url: baseURL,
    reuseExistingServer: false
  }
});
