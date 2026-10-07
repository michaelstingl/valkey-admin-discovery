import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { root as kit, kubectl, helm as runHelm, port } from './replay.mjs';
const discoveryKit = kit;

process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(kit, '../docker/.runtime/browsers');
const require = createRequire(resolve(kit, '../docker/package.json'));
const { chromium } = require('playwright');
const namespace = 'valkey-mvp-probe';
function kube(args, input) {
  return kubectl(args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}
function helm(args) { return runHelm([...args, '-n', namespace], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
assert.equal(kube(['get', 'namespace', namespace, '--ignore-not-found', '-o', 'name']).trim(), '', 'Refuse to overwrite an existing probe namespace');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const checks = [], sent = [], errors = [], catalogs = [];
let created = false, installed = false, blueCommandUrl;
const check = message => { checks.push(message); console.log(`PASS ${message}`); };
page.on('pageerror', error => errors.push(error.message));
page.on('websocket', ws => {
  ws.on('framesent', ({ payload }) => {
    const action = JSON.parse(payload.toString());
    sent.push({ type: action.type, connectionId: action.payload?.connectionId, isResume: action.payload?.isResume });
  });
  ws.on('framereceived', ({ payload }) => {
    const action = JSON.parse(payload.toString());
    if (action.type === 'valkeyConnection/catalogFulfilled') catalogs.push(action.payload.connections);
  });
});
const latest = () => catalogs.at(-1) || [];
const waitFor = async (condition, name) => {
  const end = Date.now() + 30000;
  while (Date.now() < end) { if (await condition()) return; await delay(200); }
  throw new Error(`Timed out: ${name}`);
};
const list = async query => {
  await page.getByTitle('Connections', { exact: true }).click();
  await page.getByPlaceholder('Search connections by host, port, or alias...').fill(query);
};
const ping = async () => {
  const token = `mvp-${Date.now()}`;
  await page.getByPlaceholder('Type your Valkey command here').fill(`PING ${token}`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText(token, { exact: true }).waitFor({ timeout: 10000 });
  assert.equal(await page.getByRole('dialog').count(), 0);
};
const connect = async (alias, password) => {
  await list(alias);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByText('Cluster Topology', { exact: true }).waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: 'Command', exact: true }).click();
  await ping();
};
const blueAlive = async () => {
  await page.goto(blueCommandUrl);
  await ping();
  const blue = sent.filter(a => a.type === 'valkeyConnection/connectPending' && a.connectionId?.includes('valkey-lab'));
  assert.equal(blue.length, 1, 'Blue must not reconnect during catalog updates');
};
const install = () => {
  installed = true;
  helm(['install', 'mvp-blue', 'valkey-resources', '--repo', 'https://valkey.io/valkey-helm', '--version', '0.3.0',
    '-f', resolve(discoveryKit, 'valkey.values.yaml'), '--set', 'fullnameOverride=blue',
    '--set-string', 'cluster.labels.valkey-spike=not-selected',
    '--set', 'cluster.spec.users[0].passwordSecret.name=mvp-users']);
};
try {
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle' });
  await page.getByText('valkey-lab/blue', { exact: true }).waitFor();
  await connect('valkey-lab/blue', 'demo-blue-password');
  blueCommandUrl = page.url();
  check('blue connected and returned PING before discovery changes');
  kube(['create', 'namespace', namespace]); created = true;
  kube(['-n', namespace, 'create', '-f', '-'], JSON.stringify({ apiVersion: 'v1', kind: 'Secret',
    metadata: { name: 'mvp-users', namespace }, stringData: { password: 'demo-mvp-password' } }));
  install();
  kube(['-n', namespace, 'wait', '--for=condition=Ready', 'valkeycluster/blue', '--timeout=180s']);
  const firstUid = JSON.parse(kube(['-n', namespace, 'get', 'valkeycluster/blue', '-o', 'json'])).metadata.uid;
  const before = catalogs.length;
  await waitFor(() => catalogs.length >= before + 2, 'two catalog refreshes');
  assert(!latest().some(c => c.catalogId === firstUid));
  check('unselected Helm-created Valkey remains absent');
  await list(namespace);
  kube(['-n', namespace, 'label', 'valkeycluster/blue', 'valkey-spike=shared', '--overwrite']);
  await page.getByText(`${namespace}/blue`, { exact: true }).waitFor({ timeout: 30000 });
  assert(latest().some(c => c.connectionDetails.alias === 'valkey-lab/blue'));
  check('opt-in appears in the already-open valkey-admin; duplicate blue names are namespace-qualified');
  await connect(`${namespace}/blue`, 'demo-mvp-password');
  check('new Helm-created Valkey connects with user credentials and executes PING');
  await list(namespace);
  kube(['-n', namespace, 'annotate', 'valkeycluster/blue', 'valkey-admin/alias=renamed', '--overwrite']);
  await page.getByText(`${namespace}/renamed`, { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(sent.filter(a => a.type === 'valkeyConnection/connectPending' && a.connectionId?.includes(namespace)).length, 1);
  await blueAlive();
  check('alias update is live and retains both established connections');
  await list(namespace);
  helm(['uninstall', 'mvp-blue', '--wait', '--timeout', '120s']); installed = false;
  await waitFor(() => !latest().some(c => c.catalogId === firstUid), 'deleted Valkey absent');
  await waitFor(async () => await page.getByText(`${namespace}/renamed`, { exact: true }).count() === 0, 'deleted row absent');
  await blueAlive();
  check('deletion removes the connected entry while blue stays usable without reconnect');
  install();
  kube(['-n', namespace, 'wait', '--for=condition=Ready', 'valkeycluster/blue', '--timeout=180s']);
  kube(['-n', namespace, 'label', 'valkeycluster/blue', 'valkey-spike=shared', '--overwrite']);
  const secondUid = JSON.parse(kube(['-n', namespace, 'get', 'valkeycluster/blue', '-o', 'json'])).metadata.uid;
  assert.notEqual(firstUid, secondUid);
  await list(namespace);
  await page.getByText(`${namespace}/blue`, { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(latest().find(c => c.catalogId === secondUid).resumeAvailable, false);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('dialog').getByText('Authentication Required', { exact: true }).waitFor();
  check('recreation at the same endpoint has a new identity and requires credentials');
  await page.getByLabel('Password', { exact: true }).fill('demo-mvp-password');
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByText('Cluster Topology', { exact: true }).waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: 'Command', exact: true }).click();
  await ping();
  const directSpec = JSON.parse(kube(['-n', namespace, 'get', 'valkeycluster/blue', '-o', 'json'])).spec;
  kube(['-n', namespace, 'create', '-f', '-'], JSON.stringify({ apiVersion: 'valkey.io/v1alpha1', kind: 'ValkeyCluster',
    metadata: { name: 'direct', namespace, labels: { 'valkey-spike': 'shared' } }, spec: directSpec }));
  await waitFor(() => latest().some(c => c.connectionDetails.alias === `${namespace}/direct`), 'direct CR discovered');
  check('a ValkeyCluster created outside Helm is discovered too');
  // Remove selection while viewing that node, exercising route cleanup too.
  kube(['-n', namespace, 'label', 'valkeycluster/blue', 'valkey-spike-']);
  await page.waitForURL(/#\/connect$/, { timeout: 30000 });
  await blueAlive();
  check('removing opt-in disconnects the selected removed node and returns to Connections');
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  assert(!storage.includes('demo-blue-password') && !storage.includes('demo-mvp-password'));
  assert.deepEqual(errors, []);
  writeFileSync(resolve(kit, '.runtime/k8s-catalog-result.json'), JSON.stringify({ checkedAt: new Date().toISOString(),
    checks, firstUid, secondUid, errors, sent, catalogSnapshots: catalogs.length }, null, 2)+'\n');
} catch (error) {
  await page.screenshot({ path: resolve(kit, '.runtime/k8s-catalog-failure.png'), fullPage: true });
  writeFileSync(resolve(kit, '.runtime/k8s-catalog-failure.json'), JSON.stringify({ checks, errors, sent, catalog: latest(), error: error.message }, null, 2)+'\n');
  throw error;
} finally {
  await browser.close();
  if (installed) helm(['uninstall', 'mvp-blue', '--ignore-not-found', '--wait', '--timeout', '120s']);
  if (created) kube(['delete', 'namespace', namespace, '--wait=false']);
}
