import { test, expect } from 'bun:test';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { readOnboarding, saveLocalOnboarding } from '../onboarding';
import { getConfigPath, getRequestedConfigDir } from '../load';
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

test('current routes disclose external transcription and remote execution independently of a loopback summary', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'falatrace-onboarding-routes-'));
  const path = join(root, 'config.json');
  try {
    for (const provider of ['openai', 'gemini'] as const) {
      await fs.writeFile(path, JSON.stringify({ transcription: { provider }, summary: { provider: 'ollama', ollamaUrl: 'http://127.0.0.1:11434' }, processing: { defaultTarget: 'local', autoEnqueue: true } }));
      const draft = await readOnboarding(path);
      expect(draft.local).toBe(true); // This existing flag describes the summary endpoint only.
      expect(draft.transcriptionProvider).toBe(provider);
      expect(draft.transcriptionLocal).toBe(false);
      expect(draft.transcriptionDestination).toContain('externo');
      expect(draft.processingTarget).toBe('local');
      expect(draft.automaticEnqueue).toBe(true);
    }
    await fs.writeFile(path, JSON.stringify({ transcription: { provider: 'whisper-cpp' }, processing: { defaultTarget: 'remote', autoEnqueue: true }, remote: { host: 'synthetic-private-worker.invalid', user: 'synthetic-private-user' } }));
    const remote = await readOnboarding(path);
    expect(remote.local).toBe(true);
    expect(remote.transcriptionLocal).toBe(false);
    expect(remote.processingTarget).toBe('remote');
    expect(remote.processingDestination).toContain('remoto');
    expect(JSON.stringify(remote)).not.toContain('synthetic-private');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('local save discloses preserved external backup and classification choices without their secrets', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'falatrace-onboarding-preserved-routes-'));
  const path = join(root, 'config.json');
  const original = {
    archive: { enabled: true, vaio: true, proton: true },
    proton: { enabled: true, targetFolder: '/my-files/synthetic-private-folder' },
    s3: { enabled: true, bucket: 'synthetic-private-bucket', prefix: 'synthetic-private-prefix', profile: 'synthetic-private-profile' },
    timesheet: { enabled: true, aiClassification: true },
    retention: { localCompletedWorkDays: 0, remoteIncomingDays: 3, remoteResultsDays: 45, remoteFailuresDays: 60 },
    summary: { provider: 'ollama', ollamaUrl: 'https://name:synthetic-private-password@example.invalid/synthetic-private-path?token=synthetic-private-token' }
  };
  try {
    await fs.writeFile(path, JSON.stringify(original));
    const draft = await readOnboarding(path);
    expect(draft.destination).toBe('https://example.invalid');
    expect(draft.archiveEnabled).toBe(true);
    expect(draft.archiveExternal).toBe(true);
    expect(draft.archiveDestinations).toEqual(['Worker remoto', 'Proton Drive']);
    expect(draft.s3Enabled).toBe(true);
    expect(draft.s3Destination).toContain('externo');
    expect(draft.protonEnabled).toBe(true);
    expect(draft.timesheetAIExternal).toBe(true);
    expect(draft.retention).toEqual(original.retention);
    expect(JSON.stringify(draft)).not.toContain('synthetic-private');
    const saved = await saveLocalOnboarding(draft.revision, path);
    expect(saved.saved).toBe(true);
    expect(saved.local).toBe(true);
    expect(saved.transcriptionLocal).toBe(true);
    expect(saved.processingTarget).toBe('local');
    expect(saved.automaticEnqueue).toBe(false);
    expect(saved.archiveExternal).toBe(true);
    expect(saved.s3Enabled).toBe(true);
    expect(saved.protonEnabled).toBe(true);
    expect(saved.timesheetAIExternal).toBe(true);
    expect(saved.retention).toEqual(original.retention);
    const result = JSON.parse(await fs.readFile(path, 'utf8'));
    for (const key of ['archive', 'proton', 's3', 'timesheet', 'retention'] as const) expect(result[key]).toEqual(original[key]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an inactive malformed Ollama endpoint does not block OpenAI configuration review or local migration', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'falatrace-onboarding-inactive-'));
  const path = join(root, 'config.json');
  try {
    const original = JSON.stringify({ summary: { provider: 'openai', ollamaUrl: '' }, future: { sentinel: 'preserved' } });
    await fs.writeFile(path, original);
    const draft = await readOnboarding(path);
    expect(draft.summaryProvider).toBe('openai');
    expect(draft.destination).toBe('OpenAI externo');
    expect(draft.local).toBe(false);
    expect(await fs.readFile(path, 'utf8')).toBe(original);
    const saved = await saveLocalOnboarding(draft.revision, path);
    expect(saved.saved).toBe(true);
    expect(saved.summaryProvider).toBe('ollama');
    expect(saved.local).toBe(true);
    expect(JSON.parse(await fs.readFile(path, 'utf8')).future.sentinel).toBe('preserved');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('fresh link cleanup failure reports saved with a private leftover and releases the lease; a failed commit preserves the config', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'falatrace-onboarding-commit-'));
  const path = join(root, 'config.json');
  const nativeRm = fs.rm, nativeRename = fs.rename;
  try {
    const draft = await readOnboarding(path);
    fs.rm = (async (target, options) => {
      if (String(target).startsWith(join(root, '.onboarding-'))) throw Object.assign(new Error('Synthetic temporary cleanup error'), { code: 'EACCES' });
      return nativeRm(target, options);
    }) as typeof fs.rm;
    const saved = await saveLocalOnboarding(draft.revision, path);
    expect(saved.saved).toBe(true);
    expect(saved.backupCreated).toBe(false);
    expect(saved.cleanupPending).toBe(true);
    expect(saved.revision).toBe((await readOnboarding(path)).revision);
    const leftover = (await fs.readdir(root)).find((name) => name.startsWith('.onboarding-'))!;
    expect(leftover).toBeTruthy();
    expect((await fs.stat(join(root, leftover))).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(join(root, leftover), 'utf8')).toBe(await fs.readFile(path, 'utf8'));
    fs.rm = nativeRm;
    await fs.rm(join(root, leftover));
    // A subsequent save proves the previous post-publication error did not retain the lease.
    await expect(saveLocalOnboarding(saved.revision, path)).resolves.toMatchObject({ saved: true, cleanupPending: false });
    await fs.writeFile(path, '{"summary":{"provider":"openai"},"transcription":{"provider":"gemini"},"processing":{"defaultTarget":"remote","autoEnqueue":true},"future":{"sentinel":1}}');
    const before = await fs.readFile(path, 'utf8');
    const current = await readOnboarding(path);
    fs.rename = (async (from, to) => {
      if (String(from).startsWith(join(root, '.onboarding-')) && String(to) === path) throw Object.assign(new Error('Synthetic commit error'), { code: 'EACCES' });
      return nativeRename(from, to);
    }) as typeof fs.rename;
    await expect(saveLocalOnboarding(current.revision, path)).rejects.toThrow('Synthetic commit error');
    expect(await fs.readFile(path, 'utf8')).toBe(before);
    expect((await fs.readdir(root)).some((name) => name.startsWith('.onboarding-'))).toBe(false);
  } finally {
    fs.rm = nativeRm;
    fs.rename = nativeRename;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a default destination changing from legacy to XDG invalidates a draft even when config bytes match', async () => {
  const legacy = join(homedir(), '.config', 'recording-cli', 'config.json');
  const requested = join(getRequestedConfigDir(), 'config.json');
  const qaRoot = process.env.FALATRACE_QA_ROOT;
  if (!qaRoot || !legacy.startsWith(qaRoot + '/') || !requested.startsWith(qaRoot + '/') || legacy === requested)
    throw new Error('Default-path journey requires the isolated QA HOME/XDG');
  const readExisting = (path: string) => fs.readFile(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  const oldLegacy = await readExisting(legacy), oldRequested = await readExisting(requested);
  const oldBackups = new Set(await fs.readdir(dirname(requested)).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }));
  try {
    await fs.mkdir(dirname(legacy), { recursive: true });
    await fs.mkdir(dirname(requested), { recursive: true });
    await fs.rm(requested, { force: true });
    await fs.writeFile(legacy, '{}');
    expect(getConfigPath()).toBe(legacy);
    const draft = await readOnboarding();
    await fs.writeFile(requested, '{}');
    expect(getConfigPath()).toBe(requested);
    await expect(saveLocalOnboarding(draft.revision)).rejects.toThrow('mudou');
    expect(await fs.readFile(legacy, 'utf8')).toBe('{}');
    expect(await fs.readFile(requested, 'utf8')).toBe('{}');
    const current = await readOnboarding();
    expect(current.revision).not.toBe(draft.revision);
    await expect(saveLocalOnboarding(current.revision)).resolves.toMatchObject({ saved: true });
    expect(await fs.readFile(legacy, 'utf8')).toBe('{}');
  } finally {
    if (oldLegacy) await fs.writeFile(legacy, oldLegacy);
    else await fs.rm(legacy, { force: true });
    if (oldRequested) await fs.writeFile(requested, oldRequested);
    else await fs.rm(requested, { force: true });
    for (const path of await fs.readdir(dirname(requested))) {
      if (path.startsWith('config.json.bak-') && !oldBackups.has(path)) await fs.rm(join(dirname(requested), path));
    }
  }
});

test('read and save normalize the same config path before inspecting parents or publishing', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'falatrace-onboarding-normalized-'));
  const path = join(root, 'config.json');
  const alias = root + '/never-created/../config.json';
  try {
    await fs.writeFile(path, '{"summary":{"provider":"openai"},"future":{"sentinel":1}}');
    const canonical = await readOnboarding(path);
    const normalized = await readOnboarding(alias);
    expect(normalized.exists).toBe(true);
    expect(normalized.revision).toBe(canonical.revision);
    await expect(saveLocalOnboarding(normalized.revision, alias)).resolves.toMatchObject({ saved: true });
    expect(JSON.parse(await fs.readFile(path, 'utf8')).future.sentinel).toBe(1);
    expect(await fs.stat(join(root, 'never-created')).catch(() => null)).toBeNull();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
