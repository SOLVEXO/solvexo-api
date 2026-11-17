/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { DatabaseService } from '../database/databaseservice';
import { Experiment, ExperimentDocument } from './experiment.schema';
import { MAX_EXPERIMENTS_PER_STORE, MAX_RUNNING, VariantCounts, assignVariant, isAnalyticsId, validateExperiment, verdict } from './experiments.util';

type Actor = { id: string; role: string };
const isOid = (v: unknown) => typeof v === 'string' && Types.ObjectId.isValid(v);

export interface Assignment {
  experimentId: string;
  kind: 'section' | 'theme_settings';
  sectionId: string | null;
  /** 'a' / 'b' for a running test (the visitor's exposure is reported); 'winner' = the applied winner, shown to everyone. */
  variant: 'a' | 'b' | 'winner';
  overrides: Record<string, string | number | boolean>;
}

@Injectable()
export class ExperimentsService {
  constructor(
    @InjectModel(Experiment.name) private readonly exps: Model<ExperimentDocument>,
    private readonly db: DatabaseService,
    private readonly activity: ActivityLogService,
  ) {}

  private audit(storeId: string, actor: Actor, action: string, description: string, targetId?: string) {
    return this.activity.log({ storeId, category: 'experiments', action, description, actorId: actor.id, actorRole: actor.role, targetId: targetId ?? '', targetType: 'experiment' } as any).catch(() => undefined);
  }

  // ── seller ────────────────────────────────────────────────────────────────
  list(storeId: string) { return this.exps.find({ storeId }).sort({ createdAt: -1 }).lean(); }

  async create(storeId: string, actor: Actor, body: any) {
    const v = validateExperiment(body); if (!v.ok) throw new BadRequestException(v.error);
    if ((await this.exps.countDocuments({ storeId })) >= MAX_EXPERIMENTS_PER_STORE) throw new BadRequestException(`At most ${MAX_EXPERIMENTS_PER_STORE} experiments per store. Delete an old one first.`);
    const e = await this.exps.create({ ...v.data, storeId, status: 'draft' });
    await this.audit(storeId, actor, 'experiment_created', `Experiment "${e.name}" created`, String(e._id));
    return e.toObject();
  }

  /** Only a draft can change: editing a running test would mix two different tests in one result. */
  async update(storeId: string, actor: Actor, id: string, body: any) {
    if (!isOid(id)) throw new NotFoundException('Experiment not found');
    const cur: any = await this.exps.findOne({ _id: id, storeId }).lean();
    if (!cur) throw new NotFoundException('Experiment not found');
    if (cur.status !== 'draft') throw new ConflictException('Only a draft experiment can be edited. Stop it and make a new one.');
    const v = validateExperiment(body, cur.kind); if (!v.ok) throw new BadRequestException(v.error);
    const e: any = await this.exps.findOneAndUpdate({ _id: id, storeId, status: 'draft' }, { $set: v.data }, { new: true }).lean();
    if (!e) throw new ConflictException('Only a draft experiment can be edited.');
    await this.audit(storeId, actor, 'experiment_updated', `Experiment "${e.name}" updated`, id);
    return e;
  }

  async remove(storeId: string, actor: Actor, id: string) {
    if (!isOid(id)) throw new NotFoundException('Experiment not found');
    const e: any = await this.exps.findOneAndDelete({ _id: id, storeId, status: { $ne: 'running' } }).lean();
    if (!e) throw new ConflictException('Experiment not found, or it is running (stop it first).');
    await this.audit(storeId, actor, 'experiment_deleted', `Experiment "${e.name}" deleted`, id);
    return { success: true };
  }

  /** start / resume (draft|paused -> running), pause (running -> paused), stop (running|paused -> stopped). Each is a conditional update. */
  async transition(storeId: string, actor: Actor, id: string, action: 'start' | 'pause' | 'resume' | 'stop') {
    if (!isOid(id)) throw new NotFoundException('Experiment not found');
    const cur: any = await this.exps.findOne({ _id: id, storeId }).lean();
    if (!cur) throw new NotFoundException('Experiment not found');
    const now = new Date();
    if (action === 'start' || action === 'resume') {
      const from = action === 'start' ? ['draft'] : ['paused'];
      if (!from.includes(cur.status)) throw new ConflictException(`This experiment cannot be ${action === 'start' ? 'started' : 'resumed'} now.`);
      if ((await this.exps.countDocuments({ storeId, status: 'running' })) >= MAX_RUNNING) throw new ConflictException(`At most ${MAX_RUNNING} experiments can run at once.`);
      const clash = await this.exps.exists({ storeId, status: 'running', _id: { $ne: cur._id }, ...(cur.kind === 'section' ? { sectionId: cur.sectionId } : { kind: 'theme_settings' }) });
      if (clash) throw new ConflictException(cur.kind === 'section' ? 'Another experiment is already running on this section.' : 'Another theme experiment is already running.');
      const e: any = await this.exps.findOneAndUpdate({ _id: cur._id, storeId, status: { $in: from as any } }, { $set: { status: 'running', ...(action === 'start' ? { startedAt: now } : {}) } }, { new: true }).lean();
      if (!e) throw new ConflictException('The experiment changed in the meantime.');
      await this.audit(storeId, actor, `experiment_${action}`, `Experiment "${e.name}" ${action === 'start' ? 'started' : 'resumed'}`, id);
      return e;
    }
    const map = { pause: { from: ['running'], set: { status: 'paused' } }, stop: { from: ['running', 'paused'], set: { status: 'stopped', stoppedAt: now } } } as const;
    const m = map[action];
    const e: any = await this.exps.findOneAndUpdate({ _id: cur._id, storeId, status: { $in: [...m.from] } }, { $set: m.set }, { new: true }).lean();
    if (!e) throw new ConflictException(`This experiment cannot be ${action === 'pause' ? 'paused' : 'stopped'} now.`);
    await this.audit(storeId, actor, `experiment_${action}`, `Experiment "${e.name}" ${action === 'pause' ? 'paused' : 'stopped'}`, id);
    return e;
  }

  /** Pick the winner of a stopped test. 'b' = variant B is shown to every visitor (its changes stay out of the section itself, so it is reversible); 'a' = back to the original. */
  async applyWinner(storeId: string, actor: Actor, id: string, winner: string) {
    if (!isOid(id)) throw new NotFoundException('Experiment not found');
    if (winner !== 'a' && winner !== 'b') throw new BadRequestException('Winner must be a or b');
    const e: any = await this.exps.findOneAndUpdate({ _id: id, storeId, status: 'stopped', winner: null }, { $set: { winner, appliedAt: new Date() } }, { new: true }).lean();
    if (!e) throw new ConflictException('Stop the experiment first (and a winner can be picked only once).');
    await this.audit(storeId, actor, 'experiment_winner', `Experiment "${e.name}": variant ${winner.toUpperCase()} chosen`, id);
    return e;
  }

  /** Visits, funnel steps and orders per variant (the unit is a visit/session) + a plain-language verdict on orders. */
  async results(storeId: string, id: string) {
    if (!isOid(id)) throw new NotFoundException('Experiment not found');
    const e: any = await this.exps.findOne({ _id: id, storeId }).lean();
    if (!e) throw new NotFoundException('Experiment not found');
    const rows: any[] = await (this.db.repositories as any).storefrontSessionModel.aggregate([
      { $match: { storeId, 'experiments.experimentId': id } },
      { $unwind: '$experiments' }, { $match: { 'experiments.experimentId': id } },
      { $group: { _id: '$experiments.variant', visits: { $sum: 1 }, addedToCart: { $sum: { $cond: ['$addedToCart', 1, 0] } }, reachedCheckout: { $sum: { $cond: ['$reachedCheckout', 1, 0] } }, orders: { $sum: { $cond: ['$converted', 1, 0] } } } },
    ]);
    const zero: VariantCounts = { visits: 0, addedToCart: 0, reachedCheckout: 0, orders: 0 };
    const by = (k: 'a' | 'b'): VariantCounts => { const r = rows.find((x) => x._id === k); return r ? { visits: r.visits, addedToCart: r.addedToCart, reachedCheckout: r.reachedCheckout, orders: r.orders } : { ...zero }; };
    const a = by('a'); const b = by('b');
    const rate = (c: VariantCounts) => (c.visits ? Math.round((c.orders / c.visits) * 10000) / 100 : 0);
    return { experimentId: id, status: e.status, winner: e.winner, startedAt: e.startedAt, variants: { a: { ...a, conversionRate: rate(a) }, b: { ...b, conversionRate: rate(b) } }, ...verdict(a, b) };
  }

  // ── storefront (public, anonymous) ────────────────────────────────────────
  /** What this visitor should see. No valid analytics visitor id (no consent) = nothing: everybody without consent sees the normal store. */
  async assignments(storeId: string, visitorId: string): Promise<Assignment[]> {
    if (!isOid(storeId)) return [];
    const exps: any[] = await this.exps.find({ storeId, $or: [{ status: 'running' }, { status: 'stopped', winner: 'b' }] }).lean();
    const out: Assignment[] = [];
    for (const e of exps) {
      const base = { experimentId: String(e._id), kind: e.kind, sectionId: e.sectionId ?? null };
      if (e.status === 'stopped') { out.push({ ...base, variant: 'winner', overrides: e.overrides ?? {} }); continue; }
      if (!isAnalyticsId(visitorId)) continue;
      const v = assignVariant(String(e._id), visitorId, e.trafficPercent, e.splitB);
      if (v) out.push({ ...base, variant: v, overrides: v === 'b' ? e.overrides ?? {} : {} });
    }
    return out;
  }

  /** The visit joined a test. The server recomputes the variant (the browser cannot pick one) and writes it once onto that visit. */
  async recordExposure(storeId: string, input: { sessionId: string; visitorId: string; experimentId: string }): Promise<{ recorded: boolean }> {
    if (!isOid(storeId) || !isOid(input.experimentId) || !isAnalyticsId(input.sessionId) || !isAnalyticsId(input.visitorId)) return { recorded: false };
    const e: any = await this.exps.findOne({ _id: input.experimentId, storeId, status: 'running' }).lean();
    if (!e) return { recorded: false };
    const variant = assignVariant(String(e._id), input.visitorId, e.trafficPercent, e.splitB);
    if (!variant) return { recorded: false };
    const r = await (this.db.repositories as any).storefrontSessionModel.updateOne(
      { storeId, sessionId: input.sessionId, visitorId: input.visitorId, 'experiments.experimentId': { $ne: String(e._id) } },
      { $push: { experiments: { experimentId: String(e._id), variant } } },
    );
    return { recorded: r.modifiedCount > 0 };
  }
}
