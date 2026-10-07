// Selected ValkeyCluster resources and their owned Services feed the valkey-admin catalog.
import https from 'node:https';
import { realpathSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export function connections(clusters, services) {
  const result = [];
  for (const cr of clusters) {
    const meta = cr.metadata;
    if (meta?.labels?.['valkey-spike'] !== 'shared' || meta.deletionTimestamp) continue;
    // This MVP has no client certificate / custom CA distribution.
    if (cr.spec?.networking?.tls) continue;
    const service = services.find(s => s.metadata?.namespace === meta.namespace
      && s.metadata.name === `valkey-${meta.name}` && !s.metadata.deletionTimestamp
      && s.metadata.ownerReferences?.some(o => o.kind === 'ValkeyCluster' && o.uid === meta.uid));
    const port = service?.spec?.ports?.find(p => p.name === 'valkey')?.port;
    if (!service || !port) continue;
    result.push({
      id: meta.uid, alias: `${meta.namespace}/${meta.annotations?.['valkey-admin/alias'] || meta.name}`,
      host: `${service.metadata.name}.${meta.namespace}.svc.${cr.spec?.networking?.clusterDomain || 'cluster.local'}`,
      port: String(port), username: 'default', db: 0, tls: false,
      verifyTlsCertificate: true, endpointType: 'cluster-endpoint',
    });
  }
  return result.sort((a, b) => a.host.localeCompare(b.host));
}

async function list(path) {
  const sa = '/var/run/secrets/kubernetes.io/serviceaccount';
  const [ca, token] = await Promise.all([readFile(`${sa}/ca.crt`), readFile(`${sa}/token`, 'utf8')]);
  const items = [];
  let next;
  do {
    const url = new URL(path, 'https://kubernetes.default.svc');
    url.searchParams.set('limit', '500');
    if (next) url.searchParams.set('continue', next);
    const body = await new Promise((accept, reject) => {
      const request = https.get(url, { ca, headers: { Authorization: `Bearer ${token.trim()}` } }, response => {
        if (response.statusCode !== 200) {
          response.resume(); reject(new Error(`Kubernetes HTTP ${response.statusCode}`)); return;
        }
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          try { accept(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Invalid Kubernetes response')); }
        });
      });
      request.setTimeout(10000, () => request.destroy(new Error('Kubernetes request timeout')));
      request.on('error', reject);
    });
    if (!Array.isArray(body.items)) throw new Error('Invalid Kubernetes list');
    items.push(...body.items);
    next = body.metadata?.continue;
  } while (next);
  return items;
}

export async function publish(destination, rows) {
  const body = JSON.stringify(rows);
  if (await readFile(destination, 'utf8').catch(() => '') === body) return false;
  await writeFile(`${destination}.tmp`, body, { mode: 0o644 });
  await rename(`${destination}.tmp`, destination);
  return true;
}

async function main() {
  const destination = process.env.CATALOG_FILE || '/catalog/connections.json';
  for (;;) {
    try {
      const [clusters, services] = await Promise.all([
        list('/apis/valkey.io/v1alpha1/valkeyclusters?labelSelector=valkey-spike%3Dshared'),
        list('/api/v1/services?labelSelector=app.kubernetes.io%2Fmanaged-by%3Dvalkey-operator'),
      ]);
      const rows = connections(clusters, services);
      if (await publish(destination, rows)) console.log(`Published ${rows.length} connections`);
      await writeFile(`${destination}.ready`, 'ready');
      const unsupported = clusters.filter(cr => cr.spec?.networking?.tls).length;
      if (unsupported) console.warn(`Omitted ${unsupported} TLS clusters: certificate distribution is outside this MVP`);
    } catch {
      // Never dump Kubernetes objects, request headers or tokens. Keep the last good file.
      console.error('Kubernetes catalog refresh failed; retaining the last good snapshot');
    }
    await delay(3000);
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) await main();
