import { promises as fs, constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
/** Explicit local setup, preserves unknown keys; existing configuration requires revision check + backup. */
export async function saveLocalOnboarding(revision: string, path = getConfigPath(), beforeCommit?: () => Promise<void>) {
  path = resolve(path);
  if (!/^[a-f0-9]{64}$/.test(revision))
    throw new Error('Revisão inválida. Reabra configurações.');
  const lease = await acquireSingleton(`config-audio-${createHash('sha256').update(path).digest('hex').slice(0, 16)}`);
  try {
    const previous = await raw(path);
    if (revisionFor(path, previous) !== revision)
      throw new Error('Configuração mudou; reabra antes de salvar.');
    const value = { ...previous.value, transcription: { ...previous.value.transcription, provider: 'whisper-cpp' }, summary: { ...previous.value.summary, provider: 'ollama', ollamaUrl: 'http://127.0.0.1:11434' }, processing: { ...previous.value.processing, defaultTarget: 'local', autoEnqueue: false } };
    validateConfig(mergeConfig(DEFAULT_CONFIG, value));
    const savedBytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    // Build the receipt before publication so a later read/cleanup error cannot report a saved choice as unchanged.
    const savedSnapshot = describeOnboarding(path, { value, bytes: savedBytes, exists: true });
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
    return { ...savedSnapshot, saved: true, backupCreated: !!backup, cleanupPending };
  }
  finally {
    await lease.release();
  }
}
