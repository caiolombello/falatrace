import { promises as fs, constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG } from './defaults';
import { getConfigPath, mergeConfig, validateConfig } from './load';
import { acquireSingleton } from '../runtime/singleton';
const revisionFor = (path: string, current: { exists: boolean; bytes: Buffer }) => createHash('sha256')
  .update('falatrace:onboarding:revision:v1\0')
  .update(JSON.stringify([path, current.exists])).update('\0').update(current.bytes).digest('hex');
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
function describeOnboarding(path: string, current: Awaited<ReturnType<typeof raw>>) {
  const config = mergeConfig(DEFAULT_CONFIG, current.value);
  // An inactive Ollama option must not prevent reviewing a working OpenAI configuration.
  const endpoint = config.summary.provider === 'ollama' ? new URL(config.summary.ollamaUrl) : undefined;
  const local = !!endpoint && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
  const processingLocal = config.processing.defaultTarget === 'local';
  const archiveDestinations = config.archive.enabled
    ? [config.archive.vaio ? 'Worker remoto' : '', config.archive.proton ? 'Proton Drive' : ''].filter(Boolean)
    : [];
  return {
    revision: revisionFor(path, current), exists: current.exists,
    summaryProvider: config.summary.provider,
    // Keep this existing flag scoped to the summary endpoint, not all processing routes.
    destination: endpoint ? `${endpoint.protocol}//${endpoint.host}` : 'OpenAI externo', local,
    transcriptionProvider: config.transcription.provider,
    transcriptionDestination: config.transcription.provider === 'whisper-cpp'
      ? (processingLocal ? 'Whisper.cpp neste computador' : 'Whisper.cpp no worker remoto')
      : config.transcription.provider === 'openai' ? 'OpenAI externo' : 'Gemini externo',
    transcriptionLocal: config.transcription.provider === 'whisper-cpp' && processingLocal,
    processingTarget: config.processing.defaultTarget,
    processingDestination: processingLocal ? 'Neste computador' : 'Worker remoto configurado',
    automaticEnqueue: config.processing.autoEnqueue,
    archiveEnabled: config.archive.enabled, archiveDestinations, archiveExternal: archiveDestinations.length > 0,
    s3Enabled: config.s3.enabled === true,
    s3Destination: config.s3.enabled === true ? 'Bucket S3 externo configurado' : 'Desativado',
    protonEnabled: config.proton.enabled === true,
    timesheetAIExternal: config.timesheet.enabled && config.timesheet.aiClassification,
    retention: {
      localCompletedWorkDays: config.retention.localCompletedWorkDays,
      remoteIncomingDays: config.retention.remoteIncomingDays,
      remoteResultsDays: config.retention.remoteResultsDays,
      remoteFailuresDays: config.retention.remoteFailuresDays
    },
    notice: 'Cancelar não grava. Salvar local altera providers/endpoint/destino de processamento e desativa enqueue automático; demais opções, inclusive backup e classificação, são preservadas. Modelos não são instalados ou executados.'
  };
}
export async function readOnboarding(path = getConfigPath()) {
  path = resolve(path);
  return describeOnboarding(path, await raw(path));
}
/** Backups written by the commit path and by the audio-default helper. */
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BACKUP_SUFFIX = String.raw`\.bak-(?:\d{10,16}-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`;
export const configBackupPattern = (path: string): RegExp => new RegExp('^' + escapeRegExp(basename(path)) + BACKUP_SUFFIX);
export const CONFIG_BACKUPS_KEPT = 20;
/** Keep the most recent FalaTrace configuration backups; never touches other files or the newest copy. */
export async function pruneConfigBackups(path: string, keep = CONFIG_BACKUPS_KEPT, protect?: string): Promise<number> {
  const directory = dirname(path), pattern = configBackupPattern(path);
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const names = (await fs.readdir(directory).catch(() => [] as string[])).filter((name) => pattern.test(name));
  const entries = (await Promise.all(names.map(async (name) => {
    const stat = await fs.lstat(join(directory, name)).catch(() => null);
    return stat && stat.isFile() && !stat.isSymbolicLink() && (uid === undefined || stat.uid === uid) ? { name, mtime: stat.mtimeMs } : null;
  }))).filter((entry): entry is { name: string; mtime: number } => !!entry).sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
  let removed = 0;
  for (const entry of entries.slice(keep)) {
    if (protect && join(directory, entry.name) === protect) continue;
    await fs.rm(join(directory, entry.name)).then(() => { removed += 1; }, () => undefined);
  }
  return removed;
}
/**
 * Publish a configuration derived from the current raw value. Requires the caller's revision,
 * preserves unknown keys via `transform`, writes a private exact-byte backup and never overwrites
 * a concurrent edit.
 */
export async function commitConfigChange(revision: string, path: string, transform: (value: Record<string, any>) => Record<string, any>, beforeCommit?: () => Promise<void>) {
  path = resolve(path);
  if (!/^[a-f0-9]{64}$/.test(revision))
    throw new Error('Revisão inválida. Reabra configurações.');
  const lease = await acquireSingleton(`config-audio-${createHash('sha256').update(path).digest('hex').slice(0, 16)}`);
  try {
    const previous = await raw(path);
    if (revisionFor(path, previous) !== revision)
      throw new Error('Configuração mudou; reabra antes de salvar.');
    const value = transform(previous.value);
    validateConfig(mergeConfig(DEFAULT_CONFIG, value));
    const savedBytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const dir = await fs.lstat(dirname(path));
    if (!dir.isDirectory() || dir.isSymbolicLink())
      throw new Error('Diretório inseguro; nenhuma alteração.');
    if (beforeCommit)
      await beforeCommit();
    const fresh = await raw(path);
    if (revisionFor(path, fresh) !== revision)
      throw new Error('Configuração mudou; reabra antes de salvar.');
    const tmp = join(dirname(path), `.onboarding-${randomUUID()}.tmp`);
    let backup: string | undefined;
    let committed = false;
    let cleanupPending = false;
    try {
      await fs.writeFile(tmp, savedBytes, { flag: 'wx', mode: 0o600 });
      if (previous.exists) {
        backup = path + '.bak-' + randomUUID();
        await fs.writeFile(backup, previous.bytes, { flag: 'wx', mode: 0o600 });
        const last = await raw(path);
        if (revisionFor(path, last) !== revision)
          throw new Error('Configuração mudou; reabra antes de salvar.');
        await fs.rename(tmp, path);
      }
      else
        await fs.link(tmp, path);
      committed = true;
    }
    finally {
      try { await fs.rm(tmp, { force: true }); }
      catch (error) {
        if (!committed) throw error;
        cleanupPending = true;
      }
    }
    const prunedBackups = backup ? await pruneConfigBackups(path, CONFIG_BACKUPS_KEPT, backup).catch(() => 0) : 0;
    return { path, value, bytes: savedBytes, backupCreated: !!backup, cleanupPending, prunedBackups };
  }
  finally {
    await lease.release();
  }
}
/** Read the raw configuration with the same safety checks and revision used for saving. */
export async function readConfigRevision(path = getConfigPath()) {
  path = resolve(path);
  const current = await raw(path);
  return { path, value: current.value as Record<string, any>, exists: current.exists, revision: revisionFor(path, current) };
}
/** Explicit local setup, preserves unknown keys; existing configuration requires revision check + backup. */
export async function saveLocalOnboarding(revision: string, path = getConfigPath(), beforeCommit?: () => Promise<void>) {
  const result = await commitConfigChange(revision, path, (previous) => ({ ...previous, transcription: { ...previous.transcription, provider: 'whisper-cpp' }, summary: { ...previous.summary, provider: 'ollama', ollamaUrl: 'http://127.0.0.1:11434' }, processing: { ...previous.processing, defaultTarget: 'local', autoEnqueue: false } }), beforeCommit);
  const savedSnapshot = describeOnboarding(result.path, { value: result.value, bytes: result.bytes, exists: true });
  return { ...savedSnapshot, saved: true, backupCreated: result.backupCreated, cleanupPending: result.cleanupPending };
}
