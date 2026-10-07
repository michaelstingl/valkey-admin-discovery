import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connections } from './catalog-discovery.mjs';

const cluster = (namespace = 'one', uid = 'uid-one') => ({ metadata: {
  name: 'blue', namespace, uid, labels: { 'valkey-spike': 'shared' },
}, spec: { networking: { clusterDomain: 'cluster.local' } } });
const service = (namespace = 'one', uid = 'uid-one') => ({ metadata: {
  name: 'valkey-blue', namespace, ownerReferences: [{ kind: 'ValkeyCluster', uid }],
}, spec: { ports: [{ name: 'valkey', port: 6379 }] } });

test('discovers explicitly selected clusters across namespaces using owned service addresses', () => {
  const rows = connections([cluster(), cluster('two', 'uid-two')], [service(), service('two', 'uid-two')]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.alias), ['one/blue', 'two/blue']);
  assert.equal(rows[0].host, 'valkey-blue.one.svc.cluster.local');
  assert.notEqual(rows[0].id, rows[1].id);
  assert.equal(rows[0].id, 'uid-one');
  assert(!JSON.stringify(rows).includes('password'));
});
test('does not publish unselected, deleting, TLS, or unowned endpoints', () => {
  const unselected = cluster(); unselected.metadata.labels = {};
  const deleting = cluster(); deleting.metadata.deletionTimestamp = 'now';
  const tls = cluster(); tls.spec.networking.tls = { certificates: { server: { secretName: 'private' } } };
  assert.deepEqual(connections([unselected, deleting, tls], [service()]), []);
  assert.deepEqual(connections([cluster()], [service('one', 'other-uid')]), []);
});
test('keeps endpoints through readiness changes, updates labels, and distinguishes recreation', () => {
  const cr = cluster(); cr.status = { conditions: [{ type: 'Ready', status: 'False' }] };
  cr.metadata.annotations = { 'valkey-admin/alias': 'Renamed' };
  const [row] = connections([cr], [service()]);
  assert.equal(row.alias, 'one/Renamed');
  const [recreated] = connections([cluster('one', 'new-uid')], [service('one', 'new-uid')]);
  assert.notEqual(row.id, recreated.id);
});
