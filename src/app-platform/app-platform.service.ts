/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, Optional, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { promises as dns } from 'dns';
import { Model, Types } from 'mongoose';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { decryptCredential, encryptCredential } from '../common/credential-encryption.util';
import { DatabaseService } from '../database/databaseservice';
import { ApiToken, ApiTokenDocument, WebhookSubscription, WebhookSubscriptionDocument } from '../merchant-api/merchant-api.schema';
import { generateToken, newSecret as newWebhookSecret, signPayload } from '../merchant-api/merchant-api.util';
import { isPrivateIp } from '../messaging-channels/sms.util';
import { EntitlementsService } from '../platform-plans/entitlements.service';
import { AppAuthCode, AppAuthCodeDocument, AppDefinition, AppDefinitionDocument, AppInstall, AppInstallDocument } from './app.schema';
import { CODE_TTL_MS, MAX_APPS_PER_DEVELOPER, MAX_INSTALLS_PER_STORE, SCOPE_LABEL, exactRedirect, grantable, hashSecret, installableOn, newClientId, newSecret, safeEqualHex, signSessionToken, slugOf, validateApp, widensScopes } from './app-platform.util';

type Actor = { id: string; role: string };
const isOid = (v: unknown) => typeof v === 'string' && Types.ObjectId.isValid(v);
const STATE = /^[A-Za-z0-9_\-.~:]{1,200}$/;
const hint = (s: string) => `...${s.slice(-4)}`;

/**
 * App platform: apps registered by admins or by developers (any seller account), consent screen, single-use code ->
 * per-install scoped token (a normal merchant-API token), app webhooks, uninstall. A developer's private app installs
 * only on that developer's own stores; listing for every store needs a Super Admin review.
 */
@Injectable()
export class AppPlatformService {
  private readonly log = new Logger('AppPlatform');
  constructor(
    @InjectModel(AppDefinition.name) readonly apps: Model<AppDefinitionDocument>,
    @InjectModel(AppInstall.name) readonly installs: Model<AppInstallDocument>,
    @InjectModel(AppAuthCode.name) readonly codes: Model<AppAuthCodeDocument>,
    @InjectModel(ApiToken.name) readonly tokens: Model<ApiTokenDocument>,
    @InjectModel(WebhookSubscription.name) readonly subs: Model<WebhookSubscriptionDocument>,
    private readonly db: DatabaseService,
    private readonly activity: ActivityLogService,
    @Optional() private readonly entitlements?: EntitlementsService,
  ) {}

  private audit(storeId: string, actor: Actor, action: string, description: string, targetId?: string) {
    return this.activity.log({ storeId, category: 'apps', action, description, actorId: actor.id, actorRole: actor.role, targetId: targetId ?? '', targetType: 'app' } as any).catch(() => undefined);
  }

  // ── admin registry ────────────────────────────────────────────────────────
  /** All apps, submitted ones first (the review queue). */
  async listApps() {
    const list: any[] = await this.apps.find({}).sort({ createdAt: -1 }).lean();
    const rank = (a: any) => (a.reviewStatus === 'submitted' ? 0 : 1);
    return list.sort((a, b) => rank(a) - rank(b));
  }

  /** Super Admin turns a listing request down; the app stays private and the developer sees why. */
  async reject(admin: Actor, id: string, note: unknown) {
    if (!isOid(id)) throw new NotFoundException('App not found');
    const reason = typeof note === 'string' ? note.trim().slice(0, 1000) : '';
    if (!reason) throw new BadRequestException('Say what the developer needs to change');
    const a: any = await this.apps.findOneAndUpdate({ _id: id, reviewStatus: 'submitted' }, { $set: { reviewStatus: 'rejected', reviewNote: reason } }, { new: true }).lean();
    if (!a) throw new ConflictException('App not found or not waiting for review');
    this.log.log(`App ${id} listing rejected by ${admin.id}`);
    return a;
  }

  async createApp(_admin: Actor, body: any, owner: string | null = null) {
    const v = validateApp(body, false); if (!v.ok) throw new BadRequestException(v.error);
    const clientSecret = newSecret('appsec'); const sessionSecret = newSecret('appses');
    const slug = slugOf(v.data.name);
    for (let n = 0; n < 5; n++) {
      try {
        const doc = await this.apps.create({ ...v.data, slug: n === 0 ? slug : `${slug}-${n + 1}`, clientId: newClientId(), clientSecretHash: hashSecret(clientSecret), clientSecretHint: hint(clientSecret), sessionSecretEnc: encryptCredential(sessionSecret, 'INTEGRATIONS'), status: 'draft', ownerSellerId: owner });
        return { id: String(doc._id), clientId: doc.clientId, clientSecret, sessionSecret };
      } catch (e: any) { if (e?.code !== 11000) throw e; }
    }
    throw new ConflictException('Could not pick a unique app address');
  }

  async updateApp(id: string, body: any) {
    if (!isOid(id)) throw new NotFoundException('App not found');
    const v = validateApp(body, true); if (!v.ok) throw new BadRequestException(v.error);
    const a: any = await this.apps.findOneAndUpdate({ _id: id }, { $set: v.data }, { new: true }).lean();
    if (!a) throw new NotFoundException('App not found');
    return a;
  }

  async rotateSecrets(id: string) {
    if (!isOid(id)) throw new NotFoundException('App not found');
    const clientSecret = newSecret('appsec'); const sessionSecret = newSecret('appses');
    const a: any = await this.apps.findOneAndUpdate({ _id: id }, { $set: { clientSecretHash: hashSecret(clientSecret), clientSecretHint: hint(clientSecret), sessionSecretEnc: encryptCredential(sessionSecret, 'INTEGRATIONS') } }, { new: true }).lean();
    if (!a) throw new NotFoundException('App not found');
    return { clientSecret, sessionSecret };
  }

  async approve(admin: Actor, id: string) {
    if (!isOid(id)) throw new NotFoundException('App not found');
    const a: any = await this.apps.findOneAndUpdate({ _id: id, status: { $in: ['draft', 'suspended'] } }, { $set: { status: 'approved', approvedAt: new Date(), approvedBy: admin.id, reviewStatus: 'none', reviewNote: '' } }, { new: true }).lean();
    if (!a) throw new ConflictException('App not found or already approved');
    return a;
  }

  /** Suspending an app switches it off everywhere: every install is removed and its token and webhook die at once. */
  async suspend(admin: Actor, id: string) {
    if (!isOid(id)) throw new NotFoundException('App not found');
    const a: any = await this.apps.findOneAndUpdate({ _id: id, status: { $ne: 'suspended' } }, { $set: { status: 'suspended' } }, { new: true }).select('+sessionSecretEnc').lean();
    if (!a) throw new ConflictException('App not found or already suspended');
    const list: any[] = await this.installs.find({ appId: id, status: 'installed' }).lean();
    for (const i of list) await this.teardown(a, i, { id: admin.id, role: admin.role }, 'suspended');
    return { success: true, uninstalled: list.length };
  }

  // ── store owner: browse, consent, uninstall ───────────────────────────────
  private publicApp(a: any) { return { id: String(a._id), name: a.name, slug: a.slug, description: a.description, developerName: a.developerName, clientId: a.clientId, scopes: a.requestedScopes, redirectUrls: a.redirectUrls, hasEmbed: !!a.embedUrl, embedTitle: a.embedTitle, private: a.status !== 'approved' }; }

  async listAvailable(storeId: string) {
    // Listed apps, plus the store owner's own private apps (the ones they build as a developer).
    const store: any = await this.db.repositories.storeModel.findOne({ _id: storeId, isDelete: false }).select('sellerId').lean();
    const owner = store?.sellerId ? String(store.sellerId) : null;
    const filter: Record<string, unknown> = owner ? { $or: [{ status: 'approved' }, { status: 'draft', ownerSellerId: owner }] } : { status: 'approved' };
    const [apps, inst] = await Promise.all([this.apps.find(filter).sort({ name: 1 }).lean(), this.installs.find({ storeId, status: 'installed' }).select('appId').lean()]);
    const have = new Set(inst.map((i: any) => String(i.appId)));
    return apps.map((a: any) => ({ ...this.publicApp(a), installed: have.has(String(a._id)), scopeLabels: a.requestedScopes.map((s: string) => SCOPE_LABEL[s] ?? s) }));
  }

  async listInstalled(storeId: string) {
    const inst: any[] = await this.installs.find({ storeId, status: 'installed' }).sort({ installedAt: -1 }).lean();
    const apps: any[] = await this.apps.find({ _id: { $in: inst.map((i) => i.appId) } }).lean();
    const by = new Map(apps.map((a) => [String(a._id), a]));
    return inst.filter((i) => by.has(String(i.appId))).map((i) => {
      const a = by.get(String(i.appId));
      return { installId: String(i._id), app: this.publicApp(a), grantedScopes: i.grantedScopes, scopeLabels: i.grantedScopes.map((s: string) => SCOPE_LABEL[s] ?? s), installedAt: i.installedAt, embed: a.embedUrl && a.status !== 'suspended' ? { title: a.embedTitle || a.name } : null };
    });
  }

  /** The consent screen's data. Validates exactly what the final step will validate. */
  async preview(storeId: string, q: { client_id?: string; redirect_uri?: string; scope?: string; state?: string }) {
    const a = await this.checkRequest(storeId, q);
    return { app: this.publicApp(a.app), scopes: a.scopes, scopeLabels: a.scopes.map((s) => SCOPE_LABEL[s] ?? s), redirectUri: q.redirect_uri, state: q.state, alreadyInstalled: !!(await this.installs.exists({ storeId, appId: String(a.app._id), status: 'installed' })) };
  }

  private async checkRequest(storeId: string, q: { client_id?: unknown; redirect_uri?: unknown; scope?: unknown; state?: unknown }) {
    if (typeof q.client_id !== 'string' || !q.client_id) throw new BadRequestException('Unknown app');
    const app: any = await this.apps.findOne({ clientId: q.client_id, status: { $in: ['approved', 'draft'] } }).lean();
    const owner: any = app ? await this.db.repositories.storeModel.findOne({ _id: storeId, isDelete: false }).select('sellerId').lean() : null;
    // Same answer for "no such app" and "a private app that isn't yours": nothing to learn about other developers' apps.
    if (!app || !installableOn(app, owner)) throw new NotFoundException('This app is not available');
    if (!exactRedirect(app.redirectUrls, q.redirect_uri)) throw new BadRequestException('The redirect address is not registered for this app');
    if (typeof q.state !== 'string' || !STATE.test(q.state)) throw new BadRequestException('A state value is required (1-200 letters, numbers or - _ . ~ :)');
    const wanted = typeof q.scope === 'string' ? q.scope.split(/[ ,]+/).filter(Boolean) : Array.isArray(q.scope) ? q.scope : [];
    const scopes = grantable(app.requestedScopes, wanted);
    if (!scopes) throw new BadRequestException('The app asked for permissions it did not register');
    const store: any = await this.db.repositories.storeModel.findOne({ _id: storeId, isDelete: false }).select('_id').lean();
    if (!store) throw new NotFoundException('Store not found');
    return { app, scopes };
  }

  /** The store owner presses Allow: a single-use code is issued for that app and that exact redirect address. */
  async authorize(storeId: string, actor: Actor, body: any) {
    const { app, scopes } = await this.checkRequest(storeId, { client_id: body?.client_id, redirect_uri: body?.redirect_uri, scope: body?.scope, state: body?.state });
    await this.entitlements?.assertFeatureAllowed(storeId, 'apiWebhooksAllowed', 'Apps (API & webhooks)');
    if ((await this.installs.countDocuments({ storeId, status: 'installed' })) >= MAX_INSTALLS_PER_STORE) throw new BadRequestException(`At most ${MAX_INSTALLS_PER_STORE} apps per store`);
    const code = newSecret('code');
    await this.codes.create({ codeHash: hashSecret(code), storeId, appId: String(app._id), redirectUri: body.redirect_uri, scopes, grantedBy: actor.id, expiresAt: new Date(Date.now() + CODE_TTL_MS) });
    const url = new URL(body.redirect_uri); url.searchParams.set('code', code); url.searchParams.set('state', body.state);
    await this.audit(storeId, actor, 'app_authorized', `Allowed "${app.name}" to ask for: ${scopes.join(', ')}`, String(app._id));
    return { redirectTo: url.toString() };
  }

  async uninstall(storeId: string, actor: Actor, installId: string) {
    if (!isOid(installId)) throw new NotFoundException('App not found');
    const inst: any = await this.installs.findOne({ _id: installId, storeId, status: 'installed' }).lean();
    if (!inst) throw new NotFoundException('App not found');
    const app: any = await this.apps.findById(inst.appId).select('+sessionSecretEnc').lean();
    await this.teardown(app, inst, actor, 'uninstalled');
    return { success: true };
  }

  /** Conditional claim, then revoke the install's token(s), delete its webhook(s) and tell the app (best effort). */
  private async teardown(app: any, inst: any, actor: Actor, reason: 'uninstalled' | 'suspended' | 'reinstalled'): Promise<void> {
    const claimed: any = await this.installs.findOneAndUpdate({ _id: inst._id, status: 'installed' }, { $set: { status: 'uninstalled', uninstalledAt: new Date(), uninstalledBy: actor.id } }, { new: true }).lean();
    if (!claimed) return;
    const iid = String(inst._id);
    await this.tokens.updateMany({ appInstallId: iid, revokedAt: null }, { $set: { revokedAt: new Date() } });
    await this.subs.deleteMany({ appInstallId: iid });
    await this.audit(inst.storeId, actor, reason === 'suspended' ? 'app_suspended' : 'app_uninstalled', `"${app?.name ?? 'App'}" ${reason}`, String(inst.appId));
    if (reason !== 'reinstalled' && app?.uninstallWebhookUrl && app.sessionSecretEnc) {
      let secret = ''; try { secret = decryptCredential(app.sessionSecretEnc, 'INTEGRATIONS'); } catch { return; }
      void this.notifyApp(app.uninstallWebhookUrl, secret, 'app.uninstalled', { store_id: inst.storeId, install_id: iid, reason }).catch((e) => this.log.warn(`uninstall webhook failed: ${e?.message}`));
    }
  }

  /** One signed POST (public hosts only, no redirects, 8 s). Overridable in tests. */
  protected async notifyApp(url: string, secret: string, event: string, data: Record<string, unknown>): Promise<void> {
    const host = new URL(url).hostname;
    const addrs = await dns.lookup(host, { all: true });
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('The address resolves to a private network');
    const body = JSON.stringify({ event, created_at: new Date().toISOString(), data });
    await fetch(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { 'Content-Type': 'application/json', 'User-Agent': 'Solvexo-Apps/1.0', 'X-Solvexo-Signature': signPayload(secret, body) }, body });
  }

  /** Short-lived token for the embedded page; the app verifies it with its session secret. */
  async sessionToken(storeId: string, actor: Actor, installId: string) {
    if (!isOid(installId)) throw new NotFoundException('App not found');
    const inst: any = await this.installs.findOne({ _id: installId, storeId, status: 'installed' }).lean();
    if (!inst) throw new NotFoundException('App not found');
    // An existing install keeps its page while the app is under (re)review; only a suspended app loses it.
    const app: any = await this.apps.findOne({ _id: inst.appId, status: { $ne: 'suspended' } }).select('+sessionSecretEnc').lean();
    if (!app || !app.embedUrl) throw new NotFoundException('This app has no page in the dashboard');
    const token = signSessionToken(decryptCredential(app.sessionSecretEnc, 'INTEGRATIONS'), { aud: app.clientId, sub: actor.id, store: storeId, install: installId });
    return { token, origin: new URL(app.embedUrl).origin, embedUrl: app.embedUrl, storeId };
  }

  // ── developers (any seller account): their own apps ───────────────────────

  private devView(a: any, installs = 0) {
    return {
      id: String(a._id), name: a.name, slug: a.slug, description: a.description, developerName: a.developerName, developerEmail: a.developerEmail,
      clientId: a.clientId, clientSecretHint: a.clientSecretHint, redirectUrls: a.redirectUrls, requestedScopes: a.requestedScopes,
      webhookUrl: a.webhookUrl, webhookEvents: a.webhookEvents, uninstallWebhookUrl: a.uninstallWebhookUrl, embedUrl: a.embedUrl, embedTitle: a.embedTitle,
      status: a.status, listed: a.status === 'approved', reviewStatus: a.reviewStatus ?? 'none', reviewNote: a.reviewNote ?? '', submittedAt: a.submittedAt ?? null,
      installs, createdAt: a.createdAt, updatedAt: a.updatedAt,
    };
  }

  private async ownApp(sellerId: string, id: string) {
    if (!isOid(id)) throw new NotFoundException('App not found');
    const a: any = await this.apps.findOne({ _id: id, ownerSellerId: sellerId }).lean();
    if (!a) throw new NotFoundException('App not found');
    return a;
  }

  async devList(sellerId: string) {
    const list: any[] = await this.apps.find({ ownerSellerId: sellerId }).sort({ createdAt: -1 }).lean();
    const counts: any[] = list.length ? await this.installs.aggregate([{ $match: { appId: { $in: list.map((a) => String(a._id)) }, status: 'installed' } }, { $group: { _id: '$appId', n: { $sum: 1 } } }]) : [];
    const by = new Map(counts.map((c) => [String(c._id), c.n]));
    return { items: list.map((a) => this.devView(a, by.get(String(a._id)) ?? 0)), max: MAX_APPS_PER_DEVELOPER };
  }

  async devGet(sellerId: string, id: string) {
    const a = await this.ownApp(sellerId, id);
    return this.devView(a, await this.installs.countDocuments({ appId: String(a._id), status: 'installed' }));
  }

  /** Secrets come back once, here. The app is private straight away (installs on the developer's own stores). */
  async devCreate(sellerId: string, body: any) {
    if ((await this.apps.countDocuments({ ownerSellerId: sellerId })) >= MAX_APPS_PER_DEVELOPER) throw new BadRequestException(`At most ${MAX_APPS_PER_DEVELOPER} apps per developer account`);
    const r = await this.createApp({ id: sellerId, role: 'developer' }, body, sellerId);
    void this.audit('', { id: sellerId, role: 'developer' }, 'developer_app_created', `Developer app "${String(body?.name ?? '').slice(0, 80)}" registered`, r.id);
    return r;
  }

  /**
   * Edits to the developer's own app. A listed app that asks for a NEW permission goes back to private and into the
   * review queue (stores that already installed it keep what they granted). A suspended app can't be edited.
   */
  async devUpdate(sellerId: string, id: string, body: any) {
    const a = await this.ownApp(sellerId, id);
    if (a.status === 'suspended') throw new ForbiddenException('This app is suspended. Contact Solvexo.');
    const v = validateApp(body, true); if (!v.ok) throw new BadRequestException(v.error);
    const set: Record<string, unknown> = { ...v.data };
    let relisting = false;
    if (a.status === 'approved' && widensScopes(a.requestedScopes ?? [], v.data.requestedScopes)) {
      Object.assign(set, { status: 'draft', reviewStatus: 'submitted', submittedAt: new Date(), reviewNote: '' });
      relisting = true;
    }
    const next: any = await this.apps.findOneAndUpdate({ _id: a._id, ownerSellerId: sellerId }, { $set: set }, { new: true }).lean();
    return { ...this.devView(next, await this.installs.countDocuments({ appId: String(a._id), status: 'installed' })), relisting };
  }

  async devRotate(sellerId: string, id: string) {
    const a = await this.ownApp(sellerId, id);
    if (a.status === 'suspended') throw new ForbiddenException('This app is suspended. Contact Solvexo.');
    return this.rotateSecrets(String(a._id));
  }

  /** Ask for a listing. Needs what store owners will read: a description and a contact email. */
  async devSubmit(sellerId: string, id: string) {
    const a = await this.ownApp(sellerId, id);
    if (a.status !== 'draft') throw new ConflictException(a.status === 'approved' ? 'This app is already listed' : 'This app is suspended. Contact Solvexo.');
    if (a.reviewStatus === 'submitted') throw new ConflictException('This app is already waiting for review');
    const missing = [!String(a.description ?? '').trim() && 'a description', !String(a.developerEmail ?? '').trim() && 'a support email'].filter(Boolean);
    if (missing.length) throw new BadRequestException(`Add ${missing.join(' and ')} before asking for a listing`);
    const next: any = await this.apps.findOneAndUpdate({ _id: a._id, status: 'draft', reviewStatus: { $ne: 'submitted' } }, { $set: { reviewStatus: 'submitted', submittedAt: new Date(), reviewNote: '' } }, { new: true }).lean();
    if (!next) throw new ConflictException('Please try again');
    return this.devView(next);
  }

  /** Delete a private app: every install of it is removed first (tokens and webhooks die). A listed app is unlisted by Solvexo first. */
  async devDelete(sellerId: string, id: string) {
    const a: any = await this.apps.findOne({ _id: (await this.ownApp(sellerId, id))._id }).select('+sessionSecretEnc').lean();
    if (a.status === 'approved') throw new ConflictException('A listed app can\'t be deleted. Contact Solvexo to unlist it first.');
    const list: any[] = await this.installs.find({ appId: String(a._id), status: 'installed' }).lean();
    for (const i of list) await this.teardown(a, i, { id: sellerId, role: 'developer' }, 'uninstalled');
    await this.apps.deleteOne({ _id: a._id, ownerSellerId: sellerId });
    return { success: true, uninstalled: list.length };
  }

  // ── public: the app's server swaps the code for its access token ──────────
  /** Standard OAuth 2.0 authorization-code swap (JSON or form-encoded), as Zapier and Make send it. */
  async exchange(body: any) {
    if (body?.grant_type !== undefined && body.grant_type !== 'authorization_code') throw new BadRequestException('unsupported_grant_type: only authorization_code is supported');
    const clientId = typeof body?.client_id === 'string' ? body.client_id : '';
    const clientSecret = typeof body?.client_secret === 'string' ? body.client_secret : '';
    const code = typeof body?.code === 'string' ? body.code : '';
    const redirectUri = typeof body?.redirect_uri === 'string' ? body.redirect_uri : '';
    if (!clientId || !clientSecret || !code || !redirectUri) throw new BadRequestException('client_id, client_secret, code and redirect_uri are required');
    const app: any = await this.apps.findOne({ clientId }).select('+clientSecretHash').lean();
    // Same answer for an unknown app and a wrong secret.
    if (!app || !safeEqualHex(app.clientSecretHash, hashSecret(clientSecret))) throw new UnauthorizedException('Invalid client credentials');
    if (app.status === 'suspended') throw new ForbiddenException('This app is suspended');
    const grant: any = await this.codes.findOneAndUpdate({ codeHash: hashSecret(code), appId: String(app._id), redirectUri, used: false, expiresAt: { $gt: new Date() } }, { $set: { used: true } }, { new: true }).lean();
    if (!grant) throw new BadRequestException('invalid_grant');
    // Checked again here: a private app's store must still belong to its developer when the code is swapped.
    const grantStore: any = await this.db.repositories.storeModel.findOne({ _id: grant.storeId, isDelete: false }).select('sellerId').lean();
    if (!installableOn(app, grantStore)) throw new ForbiddenException('This app is not available for this store');
    await this.entitlements?.assertFeatureAllowed(grant.storeId, 'apiWebhooksAllowed', 'Apps (API & webhooks)');
    // A fresh install replaces an older one of the same app (old token and webhook die first).
    const old: any = await this.installs.findOne({ storeId: grant.storeId, appId: String(app._id), status: 'installed' }).lean();
    if (old) await this.teardown(app, old, { id: grant.grantedBy, role: 'seller' }, 'reinstalled');
    let inst: any;
    try { inst = await this.installs.create({ storeId: grant.storeId, appId: String(app._id), grantedScopes: grant.scopes, installedBy: grant.grantedBy }); }
    catch (e: any) { if (e?.code === 11000) throw new ConflictException('This app is already being installed'); throw e; }
    const iid = String(inst._id);
    const t = generateToken();
    await this.tokens.create({ storeId: grant.storeId, name: `App: ${app.name}`.slice(0, 80), tokenHash: t.hash, prefix: t.prefix, scopes: grant.scopes, createdBy: grant.grantedBy, appInstallId: iid });
    let webhookSecret: string | null = null;
    if (app.webhookUrl && app.webhookEvents?.length) {
      webhookSecret = newWebhookSecret();
      await this.subs.create({ storeId: grant.storeId, url: app.webhookUrl, events: app.webhookEvents, secretEnc: encryptCredential(webhookSecret, 'INTEGRATIONS'), secretHint: hint(webhookSecret), description: `App: ${app.name}`.slice(0, 120), appInstallId: iid });
    }
    await this.audit(grant.storeId, { id: grant.grantedBy, role: 'seller' }, 'app_installed', `"${app.name}" installed with: ${grant.scopes.join(', ')}`, String(app._id));
    return { access_token: t.token, token_type: 'bearer', scope: grant.scopes.join(' '), store_id: grant.storeId, install_id: iid, webhook_secret: webhookSecret };
  }
}
