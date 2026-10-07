import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { runDiscovery } from '../daemon.mjs';

const row = id => ({ Id: id, State: 'running', Labels: { 'valkey-admin.discover': 'true' },
  NetworkSettings: { Networks: { lab: { IPAddress: '172.20.0.2' } } } });
async function until(fn) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise(r => setTimeout(r, 15)); }
  throw new Error('Condition did not converge');
}

test('list/events reconcile fragmented events, races, failures, reconnect and empty state without polling', async () => {
  const dir = await mkdtemp(`${tmpdir()}/engine-test-`);
  const file = `${dir}/catalog.json`;
  let rows = [row('blue')], stream, fail = false, duringList, subscribers = 0;
  const log = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/version') return res.end(JSON.stringify({ ApiVersion: '1.52' }));
    if (req.url.startsWith('/v1.52/events')) {
      subscribers++; stream = res; res.writeHead(200, { 'Content-Type': 'application/json' }); res.flushHeaders(); return;
    }
    if (req.url.startsWith('/v1.52/containers/json')) {
      assert.equal(req.method, 'GET');
      assert.match(decodeURIComponent(req.url), /valkey-admin.discover=true/);
      if (fail) { res.writeHead(500); return res.end('sensitive engine body'); }
      const snapshot = JSON.stringify(rows);
      if (duringList) { const action = duringList; duringList = undefined; action(); }
      return setTimeout(() => res.end(snapshot), 20);
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const controller = new AbortController();
  const running = runDiscovery({ endpoint: `http://127.0.0.1:${server.address().port}`, network: 'lab',
    destination: file, signal: controller.signal, resyncMs: 60000, retryMs: 30, log: message => log.push(message) });
  const ids = async () => JSON.parse(await readFile(file, 'utf8').catch(() => '[]')).map(x => x.id);
  try {
    await until(async () => (await ids()).includes('docker:blue'));
    assert(subscribers > 0);
    rows = [row('blue'), row('green')];
    stream.write('{"Type":"cont'); stream.write('ainer","Action":"start"}\n');
    await until(async () => (await ids()).length === 2);
    duringList = () => { rows = [row('replacement')]; stream.write('{"Type":"network"}\n'); };
    stream.write('{"Type":"container"}\n');
    await until(async () => (await ids())[0] === 'docker:replacement');
    fail = true; rows = []; stream.write('{}\n');
    await until(() => log.some(x => x.includes('retaining')));
    assert.deepEqual(await ids(), ['docker:replacement']);
    const oldSubscribers = subscribers; stream.destroy(); fail = false;
    await until(() => subscribers > oldSubscribers);
    await until(async () => (await ids()).length === 0);
    stream.write('{"Type":"network"}\n');
    setTimeout(() => { rows = [row('delayed-network')]; }, 40);
    await until(async () => (await ids())[0] === 'docker:delayed-network');
    assert(!log.join(' ').includes('sensitive'));
  } finally {
    controller.abort(); await running.catch(() => {});
    server.closeAllConnections(); await new Promise(r => server.close(r));
    await rm(dir, { recursive: true });
  }
});

test('periodic resync repairs a missed event', async () => {
  const dir = await mkdtemp(`${tmpdir()}/engine-poll-test-`);
  let rows = [], stream;
  const server = http.createServer((req, res) => {
    if (req.url === '/version') return res.end(JSON.stringify({ ApiVersion: '1.52' }));
    if (req.url.includes('/events')) { stream = res; res.writeHead(200); res.flushHeaders(); return; }
    res.end(JSON.stringify(rows));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const controller = new AbortController();
  const file = `${dir}/catalog.json`;
  const running = runDiscovery({ endpoint: `http://127.0.0.1:${server.address().port}`, network: 'lab',
    destination: file, signal: controller.signal, resyncMs: 100, log: () => {} });
  try {
    await until(async () => await readFile(file, 'utf8').catch(() => '') === '[]');
    rows = [row('missed')];
    await until(async () => (await readFile(file, 'utf8')).includes('docker:missed'));
  } finally {
    controller.abort(); await running.catch(() => {}); stream?.destroy();
    server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(dir, { recursive: true });
  }
});

test('Unix socket lists containers, consumes events and closes on abort', async () => {
  const dir = await mkdtemp(`${tmpdir()}/engine-unix-`);
  const socket = `${dir}/engine.sock`;
  let rows = [row('socket-blue')], stream;
  const server = http.createServer((req, res) => {
    if (req.url === '/version') return res.end(JSON.stringify({ ApiVersion: '1.52' }));
    if (req.url.includes('/events')) { stream = res; res.writeHead(200); res.flushHeaders(); return; }
    res.end(JSON.stringify(rows));
  });
  await new Promise(r => server.listen(socket, r));
  const controller = new AbortController();
  const file = `${dir}/catalog.json`;
  const running = runDiscovery({ endpoint: `unix://${socket}`, network: 'lab', destination: file,
    signal: controller.signal, resyncMs: 60000, retryMs: 30, log: () => {} });
  try {
    await until(async () => (await readFile(file, 'utf8').catch(() => '')).includes('docker:socket-blue'));
    rows = [row('socket-green')]; stream.write('{"Type":"container"}\n');
    await until(async () => (await readFile(file, 'utf8')).includes('docker:socket-green'));
  } finally {
    controller.abort(); await running;
    server.closeAllConnections(); await new Promise(r => server.close(r));
    await rm(dir, { recursive: true });
  }
});
