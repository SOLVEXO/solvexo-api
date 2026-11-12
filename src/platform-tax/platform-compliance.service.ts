/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ADAPTER_VERSIONS } from '../tax-core/adapter-versions';
import { fbrTokenFingerprint } from '../fbr-di/fbr-di.util';
import type { ComplianceState } from '../tax-core/compliance.types';
import { PlatformTaxCompliance, PlatformTaxComplianceDocument } from './schemas/platform-tax-compliance.schema';
import { PlatformTaxRule, PlatformTaxRuleDocument } from './schemas/platform-tax-rule.schema';
import { PlatformEntityService, PLATFORM_ENTITY_KEY, PLAN_SUPPLY_TYPE } from './platform-entity.service';
import { ComplianceSnapshot, complianceAllowsProduction, LIVE_CONFIRMATION, rank, reconcileState, rulePackHash } from './platform-compliance.util';

export const PLATFORM_FBR_SUBJECT = { subjectType: 'registration', subjectId: `${PLATFORM_ENTITY_KEY}:PK:PK_FBR`, entityKey: PLATFORM_ENTITY_KEY, country: 'PK', authority: 'PK_FBR' };

/** Who is acting. A team admin (anyone with `teamAdmin`) is never the Super Admin. */
export interface ComplianceActor { userId: string; teamAdmin?: boolean; name?: string }

export interface RuleInput { country: string; supplyType?: string; treatment: string; ratePercent?: number | null; source: string; accountantName: string }

const TREATMENTS = ['taxable', 'zero_rated', 'exempt', 'out_of_scope', 'unknown'];
const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

/**
 * Compliance states of SOLVEXO'S OWN tax registration: unsupported -> researched -> rules_verified -> sandbox_tested -> live_approved.
 * People move it UP (Super Admin only, with source / accountant); it falls DOWN by itself whenever what it was reached with changes.
 * This record never opens production on its own: the hard production lock in fbr-production-lock.ts is a separate, unconditional switch.
 */
@Injectable()
export class PlatformComplianceService {
  constructor(
    @InjectModel(PlatformTaxCompliance.name) private readonly model: Model<PlatformTaxComplianceDocument>,
    @InjectModel(PlatformTaxRule.name) private readonly ruleModel: Model<PlatformTaxRuleDocument>,
    private readonly entities: PlatformEntityService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  private assertSuper(actor: ComplianceActor) {
    if (actor.teamAdmin) throw new ForbiddenException('Only the Super Admin can verify tax rules or approve live filing.');
  }

  private async ensureDoc(): Promise<any> {
    await this.model.updateOne(
      { subjectType: PLATFORM_FBR_SUBJECT.subjectType, subjectId: PLATFORM_FBR_SUBJECT.subjectId },
      { $setOnInsert: { ...PLATFORM_FBR_SUBJECT, state: 'unsupported', snapshot: {}, history: [] } },
      { upsert: true },
    ).catch((e: any) => { if (e?.code !== 11000) throw e; });
    return this.model.findOne({ subjectType: PLATFORM_FBR_SUBJECT.subjectType, subjectId: PLATFORM_FBR_SUBJECT.subjectId }).lean();
  }

  private async verifiedRules(): Promise<any[]> {
    return this.ruleModel.find({ entityKey: PLATFORM_ENTITY_KEY, country: 'PK', 'verification.state': 'verified' }).lean();
  }

  /** What the state would be reached with RIGHT NOW. */
  async currentSnapshot(): Promise<ComplianceSnapshot> {
    const { entity } = await this.entities.load();
    const regs = entity.registrations.filter((r) => r.country === 'PK').map((r) => `${r.type}:${r.number}`).sort();
    const rules = await this.verifiedRules();
    const token = process.env.FBR_DI_TOKEN_SANDBOX?.trim() || '';
    return {
      registrationNumber: regs.length ? regs.join(',') : null,
      rulePackHash: rulePackHash(rules.map((r: any) => ({ country: r.country, supplyType: r.supplyType, treatment: r.treatment, ratePercent: r.ratePercent ?? null }))),
      adapterVersion: ADAPTER_VERSIONS.PK_FBR ?? null,
      tokenFingerprint: token ? fbrTokenFingerprint(token) : null,
    };
  }

  /** Lets the state fall when what it rests on changed. Never raises it. */
  private async reconcile(doc: any): Promise<any> {
    const state = doc.state as ComplianceState;
    if (rank(state) < rank('rules_verified')) return doc;
    const current = await this.currentSnapshot();
    const next = reconcileState(state, { registrationNumber: doc.snapshot?.registrationNumber ?? null, rulePackHash: doc.snapshot?.rulePackHash ?? null, adapterVersion: doc.snapshot?.adapterVersion ?? null, tokenFingerprint: doc.snapshot?.tokenFingerprint ?? null }, current);
    if (next.state === state) return doc;
    const res = await this.model.updateOne(
      { subjectType: doc.subjectType, subjectId: doc.subjectId, state },
      { $set: { state: next.state, ...(state === 'live_approved' ? { liveApprovedAt: null, liveApprovedBy: null } : {}) },
        $push: { history: { from: state, to: next.state, at: new Date(), by: 'system', byName: null, source: null, accountantName: null, note: next.reason, auto: true } } },
    );
    if (res.modifiedCount) this.activity?.log({ category: 'platform_plans', action: 'tax_compliance_downgraded', description: `Tax compliance ${state} -> ${next.state}: ${next.reason}`, actorRole: 'system' });
    return this.model.findOne({ subjectType: doc.subjectType, subjectId: doc.subjectId }).lean();
  }

  private async move(actor: ComplianceActor, from: ComplianceState, to: ComplianceState, info: { source?: string | null; accountantName?: string | null; note?: string | null }, extra: Record<string, any> = {}) {
    const res = await this.model.updateOne(
      { subjectType: PLATFORM_FBR_SUBJECT.subjectType, subjectId: PLATFORM_FBR_SUBJECT.subjectId, state: from },
      { $set: { state: to, ...extra },
        $push: { history: { from, to, at: new Date(), by: actor.userId, byName: actor.name ?? null, source: info.source ?? null, accountantName: info.accountantName ?? null, note: info.note ?? null, auto: false } } },
    );
    if (!res.modifiedCount) throw new BadRequestException('The state changed while you were doing this. Reload and try again.');
    this.activity?.log({ category: 'platform_plans', action: `tax_compliance_${to}`, description: `Tax compliance ${from} -> ${to}${info.source ? ` (source: ${info.source})` : ''}${info.accountantName ? ` (accountant: ${info.accountantName})` : ''}`, actorId: actor.userId, actorRole: 'admin' });
  }

  // ───────────────────────── read ─────────────────────────
  async getState() {
    const doc = await this.reconcile(await this.ensureDoc());
    const rules = await this.verifiedRules();
    return {
      subjectId: doc.subjectId, country: doc.country, authority: doc.authority, state: doc.state as ComplianceState,
      snapshot: doc.snapshot, history: (doc.history ?? []).slice(-50).reverse(),
      liveApprovedAt: doc.liveApprovedAt ?? null, liveApprovedBy: doc.liveApprovedBy ?? null,
      /** What the record alone would say. It does NOT open production: the hard lock is separate. */
      complianceAllowsProduction: complianceAllowsProduction(doc.state),
      productionLocked: true,
      verifiedRules: rules.map((r: any) => ({ country: r.country, supplyType: r.supplyType, treatment: r.treatment, ratePercent: r.ratePercent ?? null, source: r.verification?.source ?? null, accountantName: r.verification?.accountantName ?? null, verifiedAt: r.verification?.verifiedAt ?? null })),
    };
  }

  async allowsProduction(): Promise<boolean> {
    const doc = await this.reconcile(await this.ensureDoc());
    return complianceAllowsProduction(doc.state);
  }

  // ───────────────────────── transitions (Super Admin) ─────────────────────────
  async markResearched(actor: ComplianceActor, input: { source: string; note?: string }) {
    this.assertSuper(actor);
    const source = clean(input.source, 300);
    if (!source) throw new BadRequestException('Say where the research comes from (the law, notice or document you read).');
    const doc = await this.reconcile(await this.ensureDoc());
    if (doc.state !== 'unsupported') throw new BadRequestException('This was already marked as researched.');
    await this.move(actor, 'unsupported', 'researched', { source, note: clean(input.note, 500) || null });
    return this.getState();
  }

  /** Adds or replaces ONE verified rule. A rule only counts as verified when a Super Admin names the source and the accountant. */
  async upsertRule(actor: ComplianceActor, input: RuleInput) {
    this.assertSuper(actor);
    const country = clean(input.country, 10).toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) throw new BadRequestException('Country must be a 2-letter code.');
    const supplyType = clean(input.supplyType || PLAN_SUPPLY_TYPE, 40);
    if (!/^[a-z0-9_]{2,40}$/.test(supplyType)) throw new BadRequestException('Supply type may contain lower-case letters, digits and "_" only.');
    if (!TREATMENTS.includes(input.treatment)) throw new BadRequestException('Unknown tax treatment.');
    const source = clean(input.source, 300); const accountantName = clean(input.accountantName, 120);
    if (!source) throw new BadRequestException('Name the source of this rule (the law, notice or document).');
    if (!accountantName) throw new BadRequestException("Name the accountant who confirmed this rule.");
    let ratePercent: number | null = null;
    if (input.treatment === 'taxable') {
      ratePercent = Number(input.ratePercent);
      if (!Number.isFinite(ratePercent) || ratePercent <= 0 || ratePercent > 100) throw new BadRequestException('A taxable supply needs a rate above 0 and up to 100.');
    } else if (input.ratePercent !== undefined && input.ratePercent !== null && Number(input.ratePercent) !== 0) {
      throw new BadRequestException('Only a taxable supply has a rate.');
    }
    await this.ruleModel.updateOne(
      { entityKey: PLATFORM_ENTITY_KEY, country, supplyType },
      { $set: { treatment: input.treatment, ratePercent, verification: { state: 'verified', source, accountantName, verifiedBy: actor.userId, verifiedAt: new Date() } }, $setOnInsert: { entityKey: PLATFORM_ENTITY_KEY, country, supplyType } },
      { upsert: true },
    );
    this.activity?.log({ category: 'platform_plans', action: 'tax_rule_verified', description: `Tax rule ${country}/${supplyType} = ${input.treatment}${ratePercent ? ` ${ratePercent}%` : ''} (source: ${source}; accountant: ${accountantName})`, actorId: actor.userId, actorRole: 'admin' });
    await this.reconcile(await this.ensureDoc()); // a changed rule pack drops a verified state at once
    return this.getState();
  }

  async verifyRules(actor: ComplianceActor, input: { source: string; accountantName: string; note?: string }) {
    this.assertSuper(actor);
    const source = clean(input.source, 300); const accountantName = clean(input.accountantName, 120);
    if (!source) throw new BadRequestException('Name the source of the rules.');
    if (!accountantName) throw new BadRequestException('Name the accountant who confirmed the rules.');
    const doc = await this.reconcile(await this.ensureDoc());
    if (doc.state === 'unsupported') throw new BadRequestException('Mark the registration as researched first.');
    if (doc.state !== 'researched') throw new BadRequestException('The rules are already verified. Change a rule or the registration to verify again.');
    const snap = await this.currentSnapshot();
    if (!snap.registrationNumber) throw new BadRequestException("Add Solvexo's NTN / STRN in Settings → Tax first.");
    if (!(await this.verifiedRules()).length) throw new BadRequestException('Add at least one verified rule first.');
    await this.move(actor, 'researched', 'rules_verified', { source, accountantName, note: clean(input.note, 500) || null },
      { snapshot: { registrationNumber: snap.registrationNumber, rulePackHash: snap.rulePackHash, adapterVersion: snap.adapterVersion, tokenFingerprint: null } });
    return this.getState();
  }

  /** Called by the sandbox test when it PASSES with the token on the server. A failed test changes nothing. */
  async recordSandboxTest(ok: boolean, tokenFingerprint: string | null): Promise<{ changed: boolean }> {
    if (!ok || !tokenFingerprint) return { changed: false };
    const doc = await this.reconcile(await this.ensureDoc());
    if (doc.state !== 'rules_verified') return { changed: false };
    const snap = await this.currentSnapshot();
    const res = await this.model.updateOne(
      { subjectType: doc.subjectType, subjectId: doc.subjectId, state: 'rules_verified' },
      { $set: { state: 'sandbox_tested', 'snapshot.tokenFingerprint': tokenFingerprint, 'snapshot.adapterVersion': snap.adapterVersion },
        $push: { history: { from: 'rules_verified', to: 'sandbox_tested', at: new Date(), by: 'system', byName: null, source: 'sandbox test', accountantName: null, note: 'The FBR sandbox accepted the sample invoice.', auto: true } } },
    );
    return { changed: res.modifiedCount > 0 };
  }

  async approveLive(actor: ComplianceActor, input: { confirmation: string }) {
    this.assertSuper(actor);
    if (input.confirmation !== LIVE_CONFIRMATION) throw new BadRequestException(`Type ${LIVE_CONFIRMATION} exactly to approve.`);
    const doc = await this.reconcile(await this.ensureDoc());
    if (doc.state !== 'sandbox_tested') throw new BadRequestException('Live approval needs the rules verified AND a passed sandbox test with the current token.');
    await this.move(actor, 'sandbox_tested', 'live_approved', { note: 'Approved by the Super Admin.' }, { liveApprovedAt: new Date(), liveApprovedBy: actor.userId });
    return this.getState();
  }

  async revokeLive(actor: ComplianceActor, input: { note?: string }) {
    this.assertSuper(actor);
    const doc = await this.reconcile(await this.ensureDoc());
    if (doc.state !== 'live_approved') throw new BadRequestException('Live filing is not approved.');
    await this.move(actor, 'live_approved', 'sandbox_tested', { note: clean(input.note, 500) || 'Live approval withdrawn.' }, { liveApprovedAt: null, liveApprovedBy: null });
    return this.getState();
  }
}
