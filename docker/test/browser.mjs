import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { root, project, port, compose, run, revision, proxy } from '../replay.mjs';
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(root, '.runtime/browsers');
const { chromium } = await import('playwright');
const evidence = resolve(root, '.runtime/evidence');
mkdirSync(evidence, { recursive: true });
const checks = [], catalogs = [];
const check = message => { checks.push(message); console.log(`PASS ${message}`); };
const capture = args => compose(args, { encoding: 'utf8', stdio: 'pipe' }).trim();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('websocket', ws => ws.on('framereceived', ({ payload }) => {
  const action = JSON.parse(payload.toString());
  if (action.type === 'valkeyConnection/catalogFulfilled') catalogs.push(action.payload.connections);
}));
const alias = c => c.connectionDetails?.alias ?? c.alias;
const waitCatalog = async predicate => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (catalogs.length && predicate(catalogs.at(-1))) return catalogs.at(-1);
    await page.waitForTimeout(150);
  }
  throw new Error('Catalog did not converge');
};
const ping = async () => {
  const token = `discovery-${Date.now()}`;
  await page.getByPlaceholder('Type your Valkey command here').fill(`PING ${token}`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText(token, { exact: true }).waitFor({ timeout: 15000 });
};
const connections = async () => {
  await page.getByTitle('Connections', { exact: true }).click();
  await page.getByPlaceholder('Search connections by host, port, or alias...').fill('');
};
const connect = async color => {
  await connections();
  await page.getByPlaceholder('Search connections by host, port, or alias...').fill(color);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).fill(`demo-${color}-password`);
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByTitle('Send Command', { exact: true }).click();
  await ping();
  return page.url();
};
try {
  compose(['rm', '-sf', 'green']);
  await page.goto(`http://127.0.0.1:${port}/#/connect`, { waitUntil: 'networkidle' });
  await waitCatalog(rows => rows.length === 1 && alias(rows[0]) === 'blue');
  await page.getByText('blue', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(evidence, '01-blue.png'), fullPage: true });
  const blueRoute = await connect('blue');
  check('Initial list discovers blue; password authentication and real PING succeed');
  compose(['up', '-d', 'green']);
  await waitCatalog(rows => rows.length === 2);
  await ping();
  await connections();
  await page.getByText('green', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(evidence, '02-green-discovered.png'), fullPage: true });
  const greenRoute = await connect('green');
  const oldGreen = capture(['ps', '-q', 'green']);
  check('New green appears in the existing browser without reload; both instances accept commands');
  compose(['stop', 'green']);
  await waitCatalog(rows => rows.length === 1);
  await page.goto(blueRoute); await ping();
  check('Stopping green removes its entry while blue remains authorized');
  compose(['start', 'green']);
  await waitCatalog(rows => rows.length === 2);
  compose(['rm', '-sf', 'green']);
  await waitCatalog(rows => rows.length === 1);
  compose(['up', '-d', 'green']);
  await waitCatalog(rows => rows.length === 2);
  const newGreen = capture(['ps', '-q', 'green']);
  assert.notEqual(oldGreen, newGreen);
  const replacement = catalogs.at(-1).find(c => alias(c) === 'green');
  assert(JSON.stringify(replacement).includes(newGreen));
  assert.equal(replacement.resumeAvailable, false);
  await page.goto(blueRoute); await ping();
  check('Replacement gets a new identity and no inherited authorization; blue remains usable');
  run('docker', ['network', 'disconnect', `${project}-data`, newGreen]);
  await waitCatalog(rows => rows.length === 1);
  run('docker', ['network', 'connect', `${project}-data`, newGreen]);
  await waitCatalog(rows => rows.length === 2);
  await ping();
  check('Network detach/attach updates the catalog without interrupting blue');
  compose(['restart', 'discovery', ...(proxy ? ['docker-api'] : [])]);
  // Force a real change after restarting; a retained file alone is not proof of recovery.
  compose(['stop', 'green']);
  await waitCatalog(rows => rows.length === 1);
  compose(['start', 'green']);
  await waitCatalog(rows => rows.length === 2);
  await ping();
  check(proxy ? 'Discovery and proxy restart recover live updates' : 'Discovery restart recovers live updates');
  await page.reload({ waitUntil: 'networkidle' }); await ping();
  assert.equal(await page.getByRole('dialog').count(), 0);
  check('Reload resumes blue without another password prompt');
  if (proxy) {
  const statuses = JSON.parse(capture(['exec', '-T', 'discovery', 'node', '-e',
    "Promise.all([fetch('http://docker-api:2375/version').then(r=>r.status),fetch('http://docker-api:2375/v1.52/containers/json',{method:'POST'}).then(r=>r.status),fetch('http://docker-api:2375/v1.52/containers/x/json').then(r=>r.status)]).then(x=>console.log(JSON.stringify(x)))"]));
  assert.deepEqual(statuses, [200, 405, 403]);
  const noAccess = capture(['exec', '-T', 'valkey-admin', 'node', '-e',
    "fetch('http://docker-api:2375/version',{signal:AbortSignal.timeout(1500)}).then(()=>process.exit(1)).catch(()=>console.log('isolated'))"]);
  assert.equal(noAccess, 'isolated');
  check('Proxy denies writes/inspect; valkey-admin cannot reach Docker API');
  } else {
    const id = capture(['ps', '-q', 'discovery']);
    const inspect = JSON.parse(run('docker', ['inspect', id], { encoding: 'utf8', stdio: 'pipe' }))[0];
    assert.equal(inspect.HostConfig.NetworkMode, 'none');
    assert(inspect.Mounts.some(m => m.Destination === '/var/run/docker.sock'));
    const adminId = capture(['ps', '-q', 'valkey-admin']);
    const admin = JSON.parse(run('docker', ['inspect', adminId], { encoding: 'utf8', stdio: 'pipe' }))[0];
    assert(!admin.Mounts.some(m => m.Destination.includes('docker.sock')));
    check('Direct-socket producer has no network; valkey-admin has no socket mount');
  }
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  const catalog = capture(['exec', '-T', 'discovery', 'cat', '/catalog/connections.json']);
  const logs = capture(['logs', '--no-color', 'discovery']);
  for (const value of [storage, catalog, logs, JSON.stringify(catalogs)]) {
    assert(!value.includes('demo-blue-password') && !value.includes('demo-green-password'));
  }
  assert.deepEqual(errors, []);
  check('Passwords absent from catalog, discovery logs, catalog WebSocket responses and localStorage');
  await connections();
  await page.screenshot({ path: resolve(evidence, '03-final.png'), fullPage: true });
  const image = run('docker', ['image', 'inspect', 'valkey-admin-catalog:e37400f', '--format', '{{.Id}}'], { encoding: 'utf8', stdio: 'pipe' }).trim();
  writeFileSync(resolve(evidence, 'result.json'), JSON.stringify({ checkedAt: new Date().toISOString(), project, transport: proxy ? 'restricted-http-proxy' : 'unix-socket',
    url: `http://127.0.0.1:${port}`, sourceRevision: revision, image, checks, errors }, null, 2) + '\n');
} catch (error) {
  writeFileSync(resolve(evidence, 'failure.json'), JSON.stringify({ message: error.message, lastCatalog: catalogs.at(-1), errors }, null, 2));
  await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally { await browser.close(); }
