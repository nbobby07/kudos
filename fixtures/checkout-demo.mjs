import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scenario = process.argv[2];
if (!['broken', 'fixed'].includes(scenario) || process.argv.length !== 3) {
  console.error('Usage: node fixtures/checkout-demo.mjs broken|fixed');
  process.exit(1);
}

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = JSON.parse(await readFile(new URL('./checkout-revisions.json', import.meta.url), 'utf8'));
const sha = fixture.revisions[scenario];
let directory;
let child;
let stopping = false;
const stop = () => {
  stopping = true;
  child?.kill('SIGTERM');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

try {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid pinned commit');
  // Export the exact commit; never reset or edit the shared repository.
  const archive = spawnSync('git', ['archive', '--format=tar', sha], {
    cwd: join(root, fixture.repositoryPath), timeout: 10000,
  });
  if (archive.status !== 0) throw new Error(`Cannot export revision: ${archive.stderr}`);
  directory = await mkdtemp(join(tmpdir(), 'relay-checkout-demo-'));
  const extract = spawnSync('tar', ['-xf', '-', '-C', directory], {
    input: archive.stdout, timeout: 10000,
  });
  if (extract.status !== 0) throw new Error(`Cannot extract revision: ${extract.stderr}`);
  const setup = spawnSync('npm', ['run', 'setup'], { cwd: directory, timeout: 10000, encoding: 'utf8' });
  if (setup.status !== 0) throw new Error(`Fixture setup failed: ${setup.stdout}${setup.stderr}`);
  if (!stopping) {
    console.log(`Demo scenario: ${scenario}\nProject: ${fixture.projectId}\nCommit: ${sha}`);
    console.log('Local preview only; submit this commit to the backend for verification.');
    child = spawn(process.execPath, ['server.js'], {
      cwd: directory,
      env: { ...process.env, HOST: process.env.DEMO_HOST ?? '127.0.0.1', PORT: process.env.DEMO_PORT ?? '4173' },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const [code, signal] = await once(child, 'exit');
    if (!stopping) process.exitCode = code ?? (signal ? 1 : 0);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  if (directory) await rm(directory, { recursive: true, force: true });
}
