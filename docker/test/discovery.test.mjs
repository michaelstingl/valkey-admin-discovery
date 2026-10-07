// Unfinished acceptance draft for VPS-T13. The stub does not satisfy these tests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dockerConnections } from '../discovery.mjs';

const container = (overrides = {}) => ({
  Id: 'container-blue', State: 'running', Names: ['/demo-blue-1'],
  Labels: { 'valkey-admin.discover': 'true', 'com.docker.compose.project': 'demo', 'com.docker.compose.service': 'blue', password: 'never-publish' },
  NetworkSettings: { Networks: { shared: { IPAddress: '172.20.0.2' }, other: { IPAddress: '172.21.0.2' } } },
  ...overrides,
});

test('derives selected running containers from the chosen network without credential metadata', () => {
  assert.deepEqual(dockerConnections([container()], 'shared'), [{
    id: 'docker:container-blue', alias: 'demo/blue', host: '172.20.0.2', port: '6379',
    username: 'default', db: 0, tls: false, verifyTlsCertificate: true, endpointType: 'node',
  }]);
  assert.deepEqual(dockerConnections([
    container({ State: 'exited' }), container({ Labels: {} }), container({ NetworkSettings: { Networks: {} } }),
  ], 'shared'), []);
});

test('keeps container replacement identity distinct and uses declared alias and port', () => {
  const rows = dockerConnections([container({ Id: 'replacement', Labels: {
    'valkey-admin.discover': 'true', 'valkey-admin.alias': 'read-model', 'valkey-admin.port': '6380',
  } })], 'shared');
  assert.equal(rows[0].id, 'docker:replacement');
  assert.equal(rows[0].alias, 'read-model');
  assert.equal(rows[0].port, '6380');
});

test('omits unsupported TLS and invalid declared ports', () => {
  for (const labels of [{ 'valkey-admin.tls': 'true' }, { 'valkey-admin.port': '0' }, { 'valkey-admin.port': 'wrong' }]) {
    assert.deepEqual(dockerConnections([container({ Labels: { 'valkey-admin.discover': 'true', ...labels } })], 'shared'), []);
  }
});

test('preserves usernames and distinguishes Compose replicas', () => {
  const rows = dockerConnections([container({ Labels: { ...container().Labels,
    'com.docker.compose.container-number': '2', 'valkey-admin.username': 'reader' } })], 'shared');
  assert.equal(rows[0].username, 'reader');
  assert.equal(rows[0].alias, 'demo/blue/2');
});

test('rejects invalid addresses, identity and metadata', () => {
  for (const change of [{ Id: '' }, { NetworkSettings: { Networks: { shared: { IPAddress: 'hostname' } } } },
    { Labels: { ...container().Labels, 'valkey-admin.port': '1e3' } },
    { Labels: { ...container().Labels, 'valkey-admin.username': '' } }]) {
    assert.deepEqual(dockerConnections([container(change)], 'shared'), []);
  }
});

test('publication skips unchanged bytes and replaces a complete snapshot', async () => {
  const { publish } = await import('../discovery.mjs');
  const { mkdtemp, readFile, stat, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(`${tmpdir()}/catalog-test-`);
  try {
    const file = `${directory}/connections.json`;
    assert.equal(await publish(file, [{ id: 'first' }]), true);
    const original = await stat(file);
    assert.equal(await publish(file, [{ id: 'first' }]), false);
    assert.equal((await stat(file)).ino, original.ino);
    assert.equal(await publish(file, []), true);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), []);
  } finally { await rm(directory, { recursive: true }); }
});
