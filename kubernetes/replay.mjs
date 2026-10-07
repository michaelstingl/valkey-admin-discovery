#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = dirname(fileURLToPath(import.meta.url));
export const port = process.env.K8S_ADMIN_PORT || '18087';
const cluster = 'valkey-discovery-demo';
const runtime = resolve(root, '.runtime');
const kubeconfig = resolve(runtime, 'kubeconfig');
const marker = resolve(runtime, 'cluster.json');
const kind = process.env.KIND || 'kind';
const env = { ...process.env, HELM_CACHE_HOME: resolve(runtime, 'helm-cache'),
  HELM_CONFIG_HOME: resolve(runtime, 'helm-config'), HELM_DATA_HOME: resolve(runtime, 'helm-data') };
const adminImage = 'valkey-admin-catalog:e37400f';
const discoveryImage = 'valkey-admin-discovery:local';
const nodeImage = 'kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5';
const capture = { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] };
function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, env,
    stdio: options.input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'], ...options });
}
function containerId() { return run('docker', ['inspect', `${cluster}-control-plane`, '--format', '{{.Id}}'], capture).trim(); }
function owned() {
  if (!existsSync(marker) || JSON.parse(readFileSync(marker, 'utf8')).containerId !== containerId()) {
    throw new Error('This checkout does not own the demo cluster; refusing to modify it');
  }
}
export function kubectl(args, options) {
  owned();
  return run(process.env.KUBECTL || 'kubectl', ['--kubeconfig', kubeconfig, '--context', `kind-${cluster}`,
    '-n', 'valkey-lab', ...args], options);
}
export function helm(args, options) {
  owned();
  return run(process.env.HELM || 'helm', [...args, '--kubeconfig', kubeconfig, '--kube-context', `kind-${cluster}`], options);
}
function apply(value) { return kubectl(['apply', '-f', '-'], { input: JSON.stringify(value) }); }
function validName(name) {
  if (!/^[a-z](?:[a-z0-9-]{0,24}[a-z0-9])?$/.test(name || '')) throw new Error('Use a short lowercase DNS name');
  return name;
}
function add(name) {
  validName(name);
  apply({ apiVersion: 'v1', kind: 'Secret', metadata: { name: `${name}-users`, namespace: 'valkey-lab' },
    stringData: { password: `demo-${name}-password` } });
  helm(['upgrade', '--install', name, 'valkey-resources', '--repo', 'https://valkey.io/valkey-helm',
    '--version', '0.3.0', '-n', 'valkey-lab', '-f', resolve(root, 'valkey.values.yaml'),
    '--set-string', `fullnameOverride=${name}`, '--set-string', `cluster.spec.users[0].passwordSecret.name=${name}-users`]);
  kubectl(['wait', '--for=condition=Ready', `valkeycluster/${name}`, '--timeout=240s']);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === 'up') {
    if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error('Invalid K8S_ADMIN_PORT');
    for (const image of [adminImage, discoveryImage]) run('docker', ['image', 'inspect', image], { stdio: 'ignore' });
    const version = run(kind, ['version'], capture).match(/v(\d+)\.(\d+)\.(\d+)/);
    if (!version || (Number(version[1]) === 0 && Number(version[2]) < 33)) throw new Error('kind 0.33.0 or newer is required');
    mkdirSync(runtime, { recursive: true });
    const clusters = run(kind, ['get', 'clusters'], capture).trim().split('\n');
    if (clusters.includes(cluster)) owned();
    else {
      run(kind, ['create', 'cluster', '--name', cluster, '--image', nodeImage, '--kubeconfig', kubeconfig, '--wait', '180s']);
      writeFileSync(marker, JSON.stringify({ cluster, containerId: containerId() }) + '\n');
    }
    run(kind, ['load', 'docker-image', adminImage, discoveryImage, '--name', cluster]);
    apply({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'valkey-lab' } });
    helm(['upgrade', '--install', 'valkey-operator', 'valkey-operator', '--repo', 'https://valkey.io/valkey-helm',
      '--version', '0.7.0', '-n', 'valkey-operator-system', '--create-namespace', '--set', 'image.tag=v0.7.1',
      '--set', 'resources.limits.memory=256Mi', '--wait', '--timeout', '240s']);
    const manifest = readFileSync(resolve(root, 'deployment.yaml'), 'utf8').replaceAll('18087', port);
    kubectl(['apply', '-f', '-'], { input: manifest });
    kubectl(['rollout', 'status', 'deployment/valkey-admin-discovery', '--timeout=180s']);
    add('blue');
    console.log(`Run node kubernetes/replay.mjs serve, then open http://127.0.0.1:${port}/#/connect`);
  } else if (command === 'add') add(process.argv[3]);
  else if (command === 'remove') {
    const name = validName(process.argv[3]);
    helm(['uninstall', name, '-n', 'valkey-lab', '--wait', '--timeout', '180s']);
    kubectl(['delete', 'secret', `${name}-users`]);
  } else if (command === 'serve') {
    kubectl(['port-forward', '--address=127.0.0.1', 'service/valkey-admin-discovery', `${port}:8080`]);
  } else if (command === 'status') kubectl(['get', 'pods,valkeyclusters,services']);
  else if (command === 'test') run(process.execPath, [resolve(root, 'test-browser.mjs')]);
  else if (command === 'down') {
    owned(); run(kind, ['delete', 'cluster', '--name', cluster, '--kubeconfig', kubeconfig]);
    rmSync(marker); rmSync(kubeconfig, { force: true });
  } else throw new Error('Usage: node kubernetes/replay.mjs up|add NAME|remove NAME|serve|status|test|down');
}
