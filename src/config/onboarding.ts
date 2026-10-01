import { promises as fs, constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG } from './defaults';
import { getConfigPath, mergeConfig, validateConfig } from './load';
import { acquireSingleton } from '../runtime/singleton';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function safeParents(path: string) {
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const stat = await fs.lstat(parent).catch((e) => { if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      return null; throw e; });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new Error('Diretório inseguro; nenhuma alteração.');
    if (parent === dirname(parent))
      break;
  }
}
async function raw(path: string) {
  await safeParents(path);
  let file;
  try {
    file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      return { value: {}, bytes: Buffer.alloc(0), exists: false };
    throw e;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new Error('Configuração inválida; arquivo preservado.');
    const bytes = await file.readFile();
    const value = JSON.parse(bytes.toString());
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Configuração inválida; arquivo preservado.');
    validateConfig(mergeConfig(DEFAULT_CONFIG, value));
    return { value, bytes, exists: true };
  }
  finally {
    await file.close();
  }
}
export async function readOnboarding(path = getConfigPath()) {
  const current = await raw(path), config = mergeConfig(DEFAULT_CONFIG, current.value);
  const endpoint = new URL(config.summary.ollamaUrl);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
  return { revision: hash(current.bytes), exists: current.exists, summaryProvider: config.summary.provider, destination: config.summary.provider === 'ollama' ? `${endpoint.protocol}//${endpoint.host}` : 'OpenAI externo', local: config.summary.provider === 'ollama' && local, automaticEnqueue: config.processing.autoEnqueue, notice: 'Cancelar não grava. Salvar local altera apenas providers/endpoint e desativa enqueue automático; outras chaves são preservadas. Modelos não são instalados ou executados.' };
}
/** Explicit local setup, preserves unknown keys; existing configuration requires revision check + backup. */
export async function saveLocalOnboarding(revision: string, path = getConfigPath(), beforeCommit?: () => Promise<void>) {
  if (!/^[a-f0-9]{64}$/.test(revision))
    throw new Error('Revisão inválida. Reabra configurações.');
  const lease = await acquireSingleton(`config-audio-${createHash('sha256').update(path).digest('hex').slice(0, 16)}`);
  try {
    const previous = await raw(path);
    if (hash(previous.bytes) !== revision)
      throw new Error('Configuração mudou; reabra antes de salvar.');
    const value = { ...previous.value, transcription: { ...previous.value.transcription, provider: 'whisper-cpp' }, summary: { ...previous.value.summary, provider: 'ollama', ollamaUrl: 'http://127.0.0.1:11434' }, processing: { ...previous.value.processing, defaultTarget: 'local', autoEnqueue: false } };
    validateConfig(mergeConfig(DEFAULT_CONFIG, value));
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const dir = await fs.lstat(dirname(path));
    if (!dir.isDirectory() || dir.isSymbolicLink())
      throw new Error('Diretório inseguro; nenhuma alteração.');
    if (beforeCommit)
      await beforeCommit();
    const fresh = await raw(path);
    if (hash(fresh.bytes) !== revision || fresh.exists !== previous.exists)
      throw new Error('Configuração mudou; reabra antes de salvar.');
    const tmp = join(dirname(path), `.onboarding-${randomUUID()}.tmp`);
    let backup: string | undefined;
    try {
      await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      if (previous.exists) {
        backup = path + '.bak-' + randomUUID();
        await fs.writeFile(backup, previous.bytes, { flag: 'wx', mode: 0o600 });
        const last = await raw(path);
        if (hash(last.bytes) !== revision)
          throw new Error('Configuração mudou; reabra antes de salvar.');
        await fs.rename(tmp, path);
      }
      else
        await fs.link(tmp, path);
    }
    finally {
      await fs.rm(tmp, { force: true });
    }
    return { ...await readOnboarding(path), saved: true, backupCreated: !!backup };
  }
  finally {
    await lease.release();
  }
}
