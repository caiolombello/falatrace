import { randomUUID } from 'node:crypto';
import type { Transcript } from '../jobs/types';
import { planVisualEvidence, type VisualPlan } from './plan';
export type FramePreview = {
  id: string;
  sourceKey: string;
  expiresAt: number;
  plan: VisualPlan;
  provider: 'mock-local';
  cost: 'no-model-request';
  timing: 'approximate';
  remainingInferences: number;
  remainingPreviews: number;
};
type Item = {
  preview: FramePreview;
  cancelled: boolean;
  result?: unknown;
  running?: Promise<unknown>;
};
/** Local UX rehearsal only. There is deliberately no network/provider implementation. */
export class MockFrameReview {
  private items = new Map<string, Item>();
  private budgets = new Map<string, number>();
  private previewBudgets = new Map<string, number>();
  calls = 0;
  constructor(private now = () => Date.now(), private mock = async () => 'Observação sintética: confira a origem; não descreve o vídeo real.') { }
  prepare(sourceKey: string, hash: string, transcript: Transcript, question: string, seconds: number): FramePreview {
    for (const [id, item] of this.items)
      if (this.now() >= item.preview.expiresAt) {
        item.cancelled = true;
        this.items.delete(id);
      }
    if (!Array.isArray(transcript.segments) || transcript.segments.length > 8000)
      throw new Error('Transcrição fora do limite do ensaio visual.');
    const index = transcript.segments.findIndex(s => s.start <= seconds && seconds < s.end);
    if (index < 0)
      throw new Error('Escolha um horário dentro de um segmento da transcrição.');
    const plan = planVisualEvidence(hash, transcript, Math.max(...transcript.segments.map(s => s.end)), [{ timestampSeconds: seconds, reason: 'user-request', question, segmentIds: [`s${String(index).padStart(6, '0')}`] }]);
    if (!sourceKey || sourceKey.length > 4096 || this.items.size >= 32)
      throw new Error('Pedidos demais; cancele os previews pendentes.');
    const used = this.budgets.get(hash) || 0;
    const previews = this.previewBudgets.get(hash) || 0;
    if (previews >= 8)
      throw new Error('Budget de oito previews esgotado nesta sessão.');
    if (used >= 4)
      throw new Error('Budget mock esgotado nesta sessão.');
    this.previewBudgets.set(hash, previews + 1);
    const preview: FramePreview = { id: randomUUID(), sourceKey, expiresAt: this.now() + 300000, plan, provider: 'mock-local', cost: 'no-model-request', timing: 'approximate', remainingInferences: 4 - used, remainingPreviews: 7 - previews };
    this.items.set(preview.id, { preview, cancelled: false });
    return structuredClone(preview);
  }
  async confirm(sourceKey: string, id: string, consent: boolean) {
    const item = this.items.get(id);
    if (!consent || !item || item.preview.sourceKey !== sourceKey || item.cancelled || this.now() >= item.preview.expiresAt)
      throw new Error('Preview expirado/cancelado ou consentimento ausente. Prepare novamente.');
    if (item.result)
      return item.result;
    if (item.running)
      return item.running;
    const hash = item.preview.plan.mediaSha256, used = this.budgets.get(hash) || 0;
    if (used >= 4)
      throw new Error('Budget mock esgotado nesta sessão.');
    this.budgets.set(hash, used + 1);
    this.calls++;
    item.running = (async () => {
      const text = await this.mock();
      if (item.cancelled)
        throw new Error('Pedido cancelado; resultado descartado.');
      item.result = { provider: 'mock-local', synthetic: true, requiresReview: true, text, sourceKey, timestampSeconds: item.preview.plan.requests[0]!.timestampSeconds, segmentIds: item.preview.plan.requests[0]!.segmentIds, mediaSha256: hash, remainingInferences: 3 - used };
      return item.result;
    })();
    return item.running;
  }
  cancel(sourceKey: string, id: string) { const item = this.items.get(id); if (item?.preview.sourceKey === sourceKey) {
    item.cancelled = true;
    this.items.delete(id);
  } return { cancelled: true }; }
}
