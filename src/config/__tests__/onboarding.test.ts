import { test, expect } from 'bun:test';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readOnboarding, saveLocalOnboarding } from '../onboarding';
test('read/cancel is read-only; fresh save private; existing unknown/secret keys preserved and backup exact', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'falatrace-onboarding-'));
  const path = join(root, 'config.json');
  try {
    const fresh = await readOnboarding(path);
    expect(fresh.exists).toBe(false);
    expect(await fs.stat(path).catch(() => null)).toBeNull();
    await saveLocalOnboarding(fresh.revision, path);
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    const value = { future: { sentinel: 1 }, obs: { password: 'synthetic-private-sentinel' }, summary: { provider: 'openai', ollamaUrl: 'https://name:synthetic-private-sentinel@example.invalid/path?token=hidden' } };
    const old = JSON.stringify(value);
    await fs.writeFile(path, old);
    const draft = await readOnboarding(path);
    expect(JSON.stringify(draft)).not.toContain('synthetic-private-sentinel');
    expect(JSON.stringify(draft)).not.toContain('hidden');
    expect(draft.local).toBe(false);
    expect(await fs.readFile(path, 'utf8')).toBe(old);
    const saved = await saveLocalOnboarding(draft.revision, path);
    expect(saved.backupCreated).toBe(true);
    const result = JSON.parse(await fs.readFile(path, 'utf8'));
    expect(result.future).toEqual(value.future);
    expect(result.obs).toEqual(value.obs);
    expect(result.processing.autoEnqueue).toBe(false);
    expect(result.summary.ollamaUrl).toBe('http://127.0.0.1:11434');
    const backup = (await fs.readdir(root)).find(n => n.startsWith('config.json.bak-'))!;
    expect(await fs.readFile(join(root, backup), 'utf8')).toBe(old);
  }
  finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('invalid, symlink and concurrently edited config are preserved', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'falatrace-onboarding-'));
  const path = join(root, 'config.json');
  try {
    await fs.writeFile(path, '{invalid');
    await expect(readOnboarding(path)).rejects.toThrow();
    await expect(saveLocalOnboarding('a'.repeat(64), path)).rejects.toThrow();
    expect(await fs.readFile(path, 'utf8')).toBe('{invalid');
    await fs.rm(path);
    const target = join(root, 'target');
    await fs.writeFile(target, '{}');
    await fs.symlink(target, path);
    await expect(readOnboarding(path)).rejects.toThrow();
    expect(await fs.readFile(target, 'utf8')).toBe('{}');
    await fs.rm(path);
    const draft = await readOnboarding(path);
    await expect(saveLocalOnboarding(draft.revision, path, async () => { await fs.writeFile(path, '{"concurrent":true}'); })).rejects.toThrow('mudou');
    expect(JSON.parse(await fs.readFile(path, 'utf8')).concurrent).toBe(true);
  }
  finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('symlink ancestors are rejected and stale draft cannot overwrite later configuration', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'falatrace-onboarding-'));
  const target = join(root, 'target');
  await fs.mkdir(target);
  try {
    await fs.symlink(target, join(root, 'alias'));
    await expect(readOnboarding(join(root, 'alias/config.json'))).rejects.toThrow('inseguro');
    expect(await fs.readdir(target)).toEqual([]);
    const path = join(target, 'config.json');
    await fs.writeFile(path, '{}');
    const draft = await readOnboarding(path);
    await fs.writeFile(path, '{"later":1}');
    await expect(saveLocalOnboarding(draft.revision, path)).rejects.toThrow('mudou');
    expect(JSON.parse(await fs.readFile(path, 'utf8')).later).toBe(1);
  }
  finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
