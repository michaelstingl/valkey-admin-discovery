import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { Readable } from 'node:stream';
import { dockerConnections, publish } from './discovery.mjs';

function dockerFetch(endpoint, path, signal) {
  if (!endpoint.startsWith('unix://')) return fetch(new URL(path, endpoint), { signal });
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: fileURLToPath(endpoint.replace(/^unix:/, 'file:')), path, signal }, incoming => {
      resolve(new Response(Readable.toWeb(incoming), { status: incoming.statusCode }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Subscribe before listing. Events arriving during a list force another full snapshot. */
export async function runDiscovery({ endpoint, network, destination, signal,
  resyncMs = 30000, retryMs = 1000, log = console.log }) {
  let api, dirty = false, pending, eventTimer;
  const get = async path => {
    const response = await dockerFetch(endpoint, path, AbortSignal.any([signal, AbortSignal.timeout(10000)]));
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Docker HTTP ${response.status}`); }
    return response.json();
  };
  const refresh = () => {
    dirty = true;
    if (pending) return pending;
    pending = (async () => {
      while (dirty && !signal.aborted) {
        dirty = false;
        try {
          const filters = encodeURIComponent(JSON.stringify({ label: ['valkey-admin.discover=true'] }));
          const containers = await get(`/${api}/containers/json?filters=${filters}`);
          if (!Array.isArray(containers)) throw new Error('Invalid container list');
          const rows = dockerConnections(containers, network);
          if (await publish(destination, rows)) log(`Published ${rows.length} connections`);
        } catch {
          if (!signal.aborted) log('Docker catalog refresh failed; retaining the last good snapshot');
        }
      }
    })().finally(() => { pending = undefined; });
    return pending;
  };
  // Docker can emit a network event before ContainerList reflects the mutation.
  // Coalesce briefly, with a bounded delay even during a continuous event burst.
  const onEvent = () => {
    if (!eventTimer) eventTimer = setTimeout(() => {
      eventTimer = undefined;
      void refresh();
    }, 100);
  };
  const timer = setInterval(() => { if (api) void refresh(); }, resyncMs);
  try {
    while (!signal.aborted) {
      let reader, headerTimer;
      const streamController = new AbortController();
      try {
        const version = await get('/version');
        if (!/^1\.\d+$/.test(version.ApiVersion)) throw new Error('Invalid API version');
        api = `v${version.ApiVersion}`;
        headerTimer = setTimeout(() => streamController.abort(), 10000);
        const filters = encodeURIComponent(JSON.stringify({ type: ['container', 'network'] }));
        const response = await dockerFetch(endpoint, `/${api}/events?filters=${filters}`,
          AbortSignal.any([signal, streamController.signal]));
        clearTimeout(headerTimer);
        if (!response.ok) { await response.body?.cancel(); throw new Error('Docker events unavailable'); }
        reader = response.body.getReader();
        void refresh();
        log('Docker event stream connected');
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 1024 * 1024) throw new Error('Event exceeds limit');
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            if (line.trim()) { JSON.parse(line); onEvent(); }
          }
        }
      } catch {
        if (!signal.aborted) log('Docker event stream unavailable; reconnecting');
      } finally {
        clearTimeout(headerTimer);
        await reader?.cancel().catch(() => {});
        streamController.abort();
      }
      if (!signal.aborted) await delay(retryMs, undefined, { signal }).catch(() => {});
    }
  } finally {
    clearInterval(timer);
    clearTimeout(eventTimer);
    await pending;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const endpoint = process.env.DOCKER_ENDPOINT || 'unix:///var/run/docker.sock';
  const network = process.env.DISCOVERY_NETWORK;
  const destination = process.env.CATALOG_FILE || '/catalog/connections.json';
  if (!network) throw new Error('DISCOVERY_NETWORK is required');
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => controller.abort());
  await runDiscovery({ endpoint, network, destination, signal: controller.signal });
}
