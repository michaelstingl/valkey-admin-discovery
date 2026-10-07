import { isIPv4 } from 'node:net';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';

const text = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);

/** Convert opted-in running containers into credential-free catalog entries. */
export function dockerConnections(containers, network) {
  const rows = [];
  for (const container of containers) {
    const labels = container.Labels || {};
    const host = container.NetworkSettings?.Networks?.[network]?.IPAddress;
    if (container.State !== 'running' || labels['valkey-admin.discover'] !== 'true'
      || !text(container.Id) || !isIPv4(host || '')) continue;
    if (labels['valkey-admin.tls'] !== undefined && labels['valkey-admin.tls'] !== 'false') continue;
    const port = labels['valkey-admin.port'] ?? '6379';
    const username = labels['valkey-admin.username'] ?? 'default';
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !text(username)) continue;
    const project = labels['com.docker.compose.project'];
    const service = labels['com.docker.compose.service'];
    const replica = labels['com.docker.compose.container-number'];
    const fallback = project && service ? `${project}/${service}${replica && replica !== '1' ? `/${replica}` : ''}`
      : container.Names?.[0]?.replace(/^\//, '') || container.Id.slice(0, 12);
    const alias = labels['valkey-admin.alias'] ?? fallback;
    if (!text(alias)) continue;
    rows.push({ id: `docker:${container.Id}`, alias, host, port: String(Number(port)), username,
      db: 0, tls: false, verifyTlsCertificate: true, endpointType: 'node' });
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

/** One writer per destination; readers see either complete snapshot after rename. */
export async function publish(destination, rows) {
  const body = JSON.stringify(rows);
  let previous;
  try { previous = await readFile(destination, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous === body) return false;
  const temp = `${destination}.tmp`;
  try {
    await writeFile(temp, body, { mode: 0o644 });
    await rename(temp, destination);
  } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return true;
}
