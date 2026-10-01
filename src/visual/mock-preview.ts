import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashFile } from '../jobs/store';
import { extractVisualEvidence } from './extract';
import { MockFrameReview } from './review-flow';
import type { Transcript } from '../jobs/types';
/** Bounded local preview; the mock inspector is still called only by explicit confirm. */
export async function prepareMockFramePreview(flow: MockFrameReview, sourceKey: string, sourcePath: string, expectedHash: string, transcript: Transcript, question: string, seconds: number) {
  if (await hashFile(sourcePath) !== expectedHash)
    throw new Error('Origem mudou; preview recusado.');
  const preview = flow.prepare(sourceKey, expectedHash, transcript, question, seconds);
  const temporary = await fs.mkdtemp(join(tmpdir(), 'falatrace-local-frame-'));
  try {
    const result = await extractVisualEvidence(preview.plan, sourcePath, temporary);
    const frame = result.frames[0]!;
    const data = await fs.readFile(join(temporary, result.key, frame.file));
    return { ...preview, frameData: 'data:image/jpeg;base64,' + data.toString('base64'), frameSha256: frame.sha256, frameBytes: frame.bytes, previewRetention: 'Scratch removed after encoding; in-memory preview cleared on close' };
  }
  catch (e) {
    flow.cancel(sourceKey, preview.id);
    throw e;
  }
  finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
