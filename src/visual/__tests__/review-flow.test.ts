import { test, expect } from 'bun:test';
import { MockFrameReview } from '../review-flow';
import type { Transcript } from '../../jobs/types';
const transcript: Transcript = { version: 1, provider: 'whisper-cpp', model: 'synthetic', language: 'pt', text: 'Botão sintético à direita.', segments: [{ start: 0, end: 3, text: 'Botão sintético à direita.' }] };
const hash = 'a'.repeat(64);
test('request/preview/cancel never calls mock; explicit consent returns bounded temporal provenance, duplicate confirm is idempotent', async () => {
  const flow = new MockFrameReview();
  const p = flow.prepare('synthetic', hash, transcript, 'Onde conferir?', 1.2);
  expect(flow.calls).toBe(0);
  expect(p.provider).toBe('mock-local');
  expect(p.plan.requests[0]!.segmentIds).toEqual(['s000000']);
  await expect(flow.confirm('synthetic', p.id, false)).rejects.toThrow();
  expect(flow.calls).toBe(0);
  await expect(flow.confirm('other', p.id, true)).rejects.toThrow();
  expect(flow.calls).toBe(0);
  const [a, b] = await Promise.all([flow.confirm('synthetic', p.id, true), flow.confirm('synthetic', p.id, true)]);
  expect(a).toEqual(b);
  expect(flow.calls).toBe(1);
  expect((a as any).timestampSeconds).toBe(1.2);
  expect((a as any).requiresReview).toBe(true);
  const q = flow.prepare('synthetic', hash, transcript, 'Onde conferir?', 1);
  flow.cancel('synthetic', q.id);
  await expect(flow.confirm('synthetic', q.id, true)).rejects.toThrow();
  expect(flow.calls).toBe(1);
});
test('expired, out-of-range, malformed requests reject before mock and failures consume finite budget', async () => {
  let now = 0;
  const f = new MockFrameReview(() => now, async () => { throw new Error('synthetic failure'); });
  for (const seconds of [NaN, Infinity, -1, 3])
    expect(() => f.prepare('synthetic', hash, transcript, 'Pergunta', seconds)).toThrow();
  expect(() => f.prepare('synthetic', hash, transcript, 'bad\ncommand', 1)).toThrow();
  const p = f.prepare('synthetic', hash, transcript, 'Pergunta', 1);
  now = 300001;
  await expect(f.confirm('synthetic', p.id, true)).rejects.toThrow();
  expect(f.calls).toBe(0);
  for (let i = 0; i < 4; i++) {
    const x = f.prepare('synthetic', hash, transcript, 'Pergunta', 1);
    await expect(f.confirm('synthetic', x.id, true)).rejects.toThrow();
    await expect(f.confirm('synthetic', x.id, true)).rejects.toThrow();
  }
  expect(f.calls).toBe(4);
  expect(() => f.prepare('synthetic', hash, transcript, 'Pergunta', 1)).toThrow();
});
test('cancel while mock pending discards result without refunding consumed budget', async () => {
  let release!: () => void;
  const f = new MockFrameReview(() => 0, () => new Promise<string>(resolve => { release = () => resolve('synthetic'); }));
  const p = f.prepare('synthetic', hash, transcript, 'Pergunta', 1);
  const run = f.confirm('synthetic', p.id, true);
  f.cancel('synthetic', p.id);
  release();
  await expect(run).rejects.toThrow('cancelado');
  expect(f.calls).toBe(1);
});
test('preview budget survives cancellation and returned plan cannot mutate consent-bound timestamp', async () => {
  const f = new MockFrameReview();
  const p = f.prepare('synthetic', hash, transcript, 'Pergunta', 1);
  p.plan.requests[0]!.timestampSeconds = 2;
  const result = await f.confirm('synthetic', p.id, true);
  expect((result as any).timestampSeconds).toBe(1);
  for (let i = 0; i < 7; i++) {
    const preview = f.prepare('synthetic', hash, transcript, 'Pergunta', 1);
    f.cancel('synthetic', preview.id);
  }
  expect(() => f.prepare('synthetic', hash, transcript, 'Pergunta', 1)).toThrow('oito previews');
  expect(f.calls).toBe(1);
});
