#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = dirname(fileURLToPath(import.meta.url));
export const revision = 'e37400f94b3f5b0aaec3e13eecfc7fd583b1678b';
export const project = process.env.COMPOSE_PROJECT_NAME || 'valkey-discovery';
export const proxy = process.env.DISCOVERY_PROXY === '1';
export const port = process.env.ADMIN_PORT || '18085';
export const env = { ...process.env, COMPOSE_PROJECT_NAME: project, ADMIN_PORT: port, BUILDX_CONFIG: resolve(root, '.runtime/buildx') };
export function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, env, stdio: 'inherit', ...options });
}
export function compose(args, options) {
  return run('docker', ['compose', '-f', 'compose.yaml', '-f', 'compose.green.yaml', ...(proxy ? ['-f', 'compose.proxy.yaml'] : []), ...args], options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === 'build') {
    const source = resolve(root, '.runtime/valkey-admin');
    mkdirSync(source, { recursive: true });
    if (!existsSync(resolve(source, '.git'))) {
      run('git', ['init', source]);
      run('git', ['-C', source, 'fetch', '--depth=1', 'https://github.com/michaelstingl/valkey-io-valkey-admin.git', revision]);
      run('git', ['-C', source, 'checkout', '--detach', 'FETCH_HEAD']);
    }
    const head = run('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim();
    if (head !== revision) throw new Error('Build source revision differs; use a fresh .runtime directory');
    const dirty = run('git', ['-C', source, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8', stdio: 'pipe' });
    if (dirty) throw new Error('Build source has tracked modifications');
    const context = resolve(root, '.runtime/build-context');
    const archive = resolve(root, '.runtime/source.tar');
    run('git', ['-C', source, 'archive', '--format=tar', '-o', archive, revision]);
    rmSync(context, { recursive: true, force: true });
    mkdirSync(context, { recursive: true });
    run('tar', ['-xf', archive, '-C', context]);
    const dockerfile = readFileSync(resolve(context, 'docker/Dockerfile.app'), 'utf8')
      .replaceAll('node:22-bookworm-slim', 'node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392')
      .replace('RUN npm ci\n', 'ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1\nRUN npm ci\n');
    writeFileSync(resolve(context, '.Dockerfile.demo'), dockerfile);
    run('docker', ['build', '--label', `org.opencontainers.image.revision=${revision}`, '-f', resolve(context, '.Dockerfile.demo'), '-t', 'valkey-admin-catalog:e37400f', context]);
    compose(['build', 'discovery']);
  } else if (command === 'up') {
    compose(['up', '-d', '--remove-orphans', ...(proxy ? ['docker-api'] : []), 'discovery', 'valkey-admin', 'blue']);
    const deadline = Date.now() + 60000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const response = await fetch('http://127.0.0.1:' + port, { signal: AbortSignal.timeout(2000) });
        await response.body?.cancel();
        if (response.ok) { ready = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error('valkey-admin did not become ready within 60 seconds');
    console.log('Open http://127.0.0.1:' + port + '/#/connect');
  }
  else if (command === 'add') compose(['up', '-d', 'green']);
  else if (command === 'remove') compose(['rm', '-sf', 'green']);
  else if (command === 'down') compose(['down', '-v', '--remove-orphans']);
  else if (command === 'test') run(process.execPath, ['test/browser.mjs']);
  else throw new Error('Usage: node replay.mjs build|up|add|remove|test|down');
}
