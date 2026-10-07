import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

async function isolated(command) {
  const dir = await realpath(await mkdtemp(`${tmpdir()}/discovery-cli-`));
  try {
    await copyFile(new URL('./replay.mjs', import.meta.url), `${dir}/replay.mjs`);
    try { execFileSync(process.execPath, [`${dir}/replay.mjs`, ...command], { stdio: 'pipe' }); }
    catch (error) { return error.stderr.toString(); }
    assert.fail('Expected refusal');
  } finally { await rm(dir, { recursive: true }); }
}

test('rejects malformed release names before accessing Kubernetes', async () => {
  for (const name of ['green-', '-green', 'Green', 'a/b']) {
    assert.match(await isolated(['add', name]), /Use a short lowercase DNS name/);
  }
});

test('a checkout without ownership state cannot delete a cluster', async () => {
  assert.match(await isolated(['down']), /does not own the demo cluster/);
});
