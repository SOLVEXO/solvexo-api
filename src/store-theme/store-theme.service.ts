/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { randomBytes } from 'crypto';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { validateBlockSettings } from '../common/store-content/section-settings.validator';
import { ContentVersioningService } from '../common/content-versioning/content-versioning.service';
import { StoreThemeDraft } from './schemas/store-theme.schema';
import { UpdateThemeDto } from './dto/update-theme.dto';
import { UpdateHeaderDto } from './dto/update-header.dto';
import { UpdateFooterDto } from './dto/update-footer.dto';
import { UpdateIdentityBannerDto } from './dto/update-identity-banner.dto';
import { InstallThemeDto } from './dto/install-theme.dto';
import { CreateColorSchemeDto } from './dto/color-scheme.dto';
import { MenusService } from '../menus/menus.service';

const HEADER_ALLOWED_BLOCK_TYPES = ['nav_link'];
const FOOTER_ALLOWED_BLOCK_TYPES = ['footer_column', 'social_link', 'copyright_text'];
const MAX_HEADER_LINKS = 10;
const MAX_FOOTER_BLOCKS = 20;

// The one theme package every store gets automatically the moment it's
// created — must exist as a real theme package on the frontend. Was
// 'warm-craft' (a theme object from the old, now-superseded 12-theme
// gallery, which the current Theme Library UI doesn't even list any more) —
// every brand-new store was silently launching with a theme invisible in
// its own Theme Library, never the real Atelier theme. Fixed to the one
// real, complete theme that actually exists today
// (`src/features/storefront-themes/theme-01-atelier/`). This schema's own
// field-level defaults below (primaryColor/bgColor/textColor/accentColor/
// font, etc.) already exactly match Atelier's real default palette — they
// were never changed, so this is a one-line, zero-risk correction, not a
// new seed. Backend only ever needs the *id*, never the definition's
// content — see the class comment on `StoreTheme` for why.
const DEFAULT_THEME_DEFINITION_ID = 'theme-01-atelier';

function validateBlocks(blocks: { type: string; settings: Record<string, any> }[], allowed: string[], max: number) {
  if (blocks.length > max) throw new BadRequestException(`Cannot have more than ${max} items`);
  for (const block of blocks) {
    if (!allowed.includes(block.type)) throw new BadRequestException(`Block type "${block.type}" is not allowed here`);
    validateBlockSettings(block.type, block.settings ?? {});
  }
}

const MAX_CUSTOM_CSS_LENGTH = 20_000;
// CSS itself can't execute code or read cookies/make network requests the
// way JS can — the real, structural reason this feature is safe to expose
// to an ordinary merchant without a sandboxing layer. These are the actual
// injection vectors that DO exist at the CSS level (a `javascript:`-scheme
// URL inside `url(...)`, and the long-deprecated IE-only `expression()`
// dynamic-property mechanism) — blocked outright rather than left as a
// theoretical gap.
const CSS_INJECTION_PATTERNS = [/javascript\s*:/i, /expression\s*\(/i];

/** Real validation, not just a free-text field: length-capped, scanned for
 *  the known CSS-level injection vectors above. Returns the trimmed value
 *  (or null for an empty/omitted one) — never throws for merely "unusual"
 *  CSS, since a merchant/developer must be able to write genuinely
 *  arbitrary (if layout-risky) styling; only the two concrete vectors above
 *  are rejected. */
function validateCustomCss(customCss: string | null | undefined): string | null {
  if (!customCss || !customCss.trim()) return null;
  const trimmed = customCss.trim();
  if (trimmed.length > MAX_CUSTOM_CSS_LENGTH) {
    throw new BadRequestException(`Custom CSS cannot exceed ${MAX_CUSTOM_CSS_LENGTH.toLocaleString()} characters`);
  }
  for (const pattern of CSS_INJECTION_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new BadRequestException('Custom CSS contains a disallowed pattern (javascript: URLs and expression() are not permitted)');
    }
  }
  return trimmed;
}

@Injectable()
export class StoreThemeService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly contentVersioningService: ContentVersioningService,
    private readonly menusService: MenusService,
  ) {}

  /** If `header.menuId` is set, replaces `header.blocks` with that Menu's
   *  items — resolved into the identical `{type:'nav_link', settings}`
   *  shape a real nav_link block already has, so every existing consumer
   *  (both themes' Navbar components, the seller-facing preview) needed
   *  zero changes to render an attached menu. A dangling/deleted menuId
   *  falls back to the header's own `blocks` untouched, never a crash or an
   *  empty nav — the header is simply as if no menu were attached. */
  private async resolveHeaderMenu(storeId: string, header: any) {
    if (!header?.menuId) return header;
    const menu = await this.menusService.getRaw(storeId, header.menuId);
    if (!menu) return header;
    return {
      ...header,
      blocks: menu.items.map(item => ({
        _id: item.id,
        type: 'nav_link',
        settings: item,
        enabled: true,
      })),
    };
  }

  /** Footer's own version of `resolveHeaderMenu` — see `StorefrontFooter.menuId`'s
   *  schema doc comment for why this can't just swap out `blocks` wholesale
   *  the way the header does. The resolved menu becomes ONE synthetic
   *  `footer_column` block (heading = the menu's own name) that REPLACES only
   *  the footer's existing `footer_column` block(s); any `social_link`/
   *  `copyright_text` blocks pass through untouched. */
  private async resolveFooterMenu(storeId: string, footer: any) {
    if (!footer?.menuId) return footer;
    const menu = await this.menusService.getRaw(storeId, footer.menuId);
    if (!menu) return footer;
    const menuColumn = {
      _id: `menu-${menu._id}`,
      type: 'footer_column',
      settings: { heading: menu.name, links: menu.items },
      enabled: true,
    };
    const nonColumnBlocks = (footer.blocks ?? []).filter((b: any) => b.type !== 'footer_column');
    return { ...footer, blocks: [menuColumn, ...nonColumnBlocks] };
  }

  private get storeThemeModel() {
    return this.databaseService.repositories.storeThemeModel;
  }
  private get storeModel() {
    return this.databaseService.repositories.storeModel;
  }

  // ── Theme Definition ⟷ Installed Theme Instance ─────────────────────────
  // A `themeDefinitionId` names a code-shipped theme package (frontend
  // `builder/themes/<id>/` — never stored here, theme source is code, not
  // merchant data). Every method below operates on one INSTALLED ROW for a
  // store. Callers that don't care which installed theme (the entire
  // pre-existing surface — Store Builder's Theme/Header/Footer tabs, Live
  // Preview, the public storefront) simply omit `installedThemeId` and
  // always get the store's one ACTIVE row, so none of that existing surface
  // needed to change to keep working.

  /** Idempotent — called once from `StoreService.createStore()` right after a store is created, and safe to call again (upsert) for the one-off backfill of pre-existing stores. Ensures the store has an ACTIVE installed theme (the default package, if none exists yet). Never called from an unauthenticated read path (see plan: eager creation avoids a public-GET-does-a-write race). */
  async ensureDefaultTheme(storeId: string) {
    await this.storeThemeModel.findOneAndUpdate(
      { storeId, status: 'active' },
      { $setOnInsert: { storeId, status: 'active', themeDefinitionId: DEFAULT_THEME_DEFINITION_ID } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    // Backfill `themeDefinitionId` for any active row written before this
    // field existed (a real app-level check is safe here, unlike `draft`
    // below, since `null` can never be a legitimately-chosen value).
    await this.storeThemeModel.updateMany(
      { storeId, status: 'active', themeDefinitionId: null },
      { $set: { themeDefinitionId: DEFAULT_THEME_DEFINITION_ID, 'draft.themeDefinitionId': DEFAULT_THEME_DEFINITION_ID } },
    );
    // Backfill `draft` = a copy of the live root fields, for any store that
    // predates the draft/publish split — see ContentVersioningService for
    // why the raw `$exists` filter is required. No-ops harmlessly (0
    // matched) for every store that already has a real `draft`, including a
    // brand-new store — `setDefaultsOnInsert` already populated `draft` at
    // insert time above.
    await this.contentVersioningService.backfillDraft(this.storeThemeModel, { storeId, status: 'active' }, 'draft', {
      theme: '$theme',
      header: '$header',
      footer: '$footer',
      identityBanner: '$identityBanner',
      baseThemeId: '$baseThemeId',
      themeDefinitionId: '$themeDefinitionId',
      customCss: '$customCss',
    });
    return this.storeThemeModel.findOne({ storeId, status: 'active' });
  }

  /** Resolves the row a call should operate on: a specific installed theme if `installedThemeId` is given (verified to belong to the store), otherwise the store's active row (auto-creating the default if this is the store's very first touch). */
  private async resolveInstance(storeId: string, installedThemeId?: string) {
    const doc = installedThemeId
      ? await this.storeThemeModel.findOne({ _id: installedThemeId, storeId })
      : await this.ensureDefaultTheme(storeId);
    if (!doc) throw new NotFoundException('Installed theme not found');
    return doc;
  }

  async listInstalled(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    await this.ensureDefaultTheme(storeId);
    const rows = await this.storeThemeModel.find({ storeId }).sort({ status: -1, installedAt: -1 }).lean();
    return { success: true, data: rows };
  }

  /** Theme Library "Install" — creates a new installed row for a theme package, seeded from the definition's own default bundle (sent by the frontend, which is the single source of truth for what a definition's defaults are). Installing does NOT activate it — a merchant reviews/customizes via Customize first, then explicitly Activates. Re-installing an already-installed definition just returns the existing row (idempotent), matching Shopify's own "already installed" behavior. */
  async installTheme(storeId: string, sellerId: string, dto: InstallThemeDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    await this.ensureDefaultTheme(storeId);

    const existing = await this.storeThemeModel.findOne({ storeId, themeDefinitionId: dto.themeDefinitionId });
    if (existing) return { success: true, message: 'Theme already installed', data: existing };

    const seed = {
      theme: dto.theme ?? {},
      header: dto.header ?? {},
      footer: dto.footer ?? {},
      identityBanner: dto.identityBanner ?? {},
    };
    const created = await this.storeThemeModel.create({
      storeId,
      themeDefinitionId: dto.themeDefinitionId,
      status: 'installed',
      baseThemeId: dto.themeDefinitionId,
      ...seed,
      draft: { ...seed, baseThemeId: dto.themeDefinitionId, themeDefinitionId: dto.themeDefinitionId },
    });
    return { success: true, message: 'Theme installed', data: created };
  }

  /** Theme Library "Duplicate" — a second, independently-configurable
   *  installed row for the SAME theme package, seeded from `source`'s
   *  current live+draft content so the copy starts out identical (real
   *  Shopify convention — you edit a duplicate, not the original, while
   *  experimenting). Always lands as `status: 'installed'`, never active —
   *  duplicating never changes what's currently live. `versions`/
   *  `lastPublishedAt` are deliberately NOT copied: this is a new row with
   *  its own fresh history, not a fork of the source's publish history. */
  async duplicateTheme(storeId: string, sellerId: string, installedThemeId: string, name?: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const source = await this.storeThemeModel.findOne({ _id: installedThemeId, storeId }).lean();
    if (!source) throw new NotFoundException('Installed theme not found');
    const duplicate = await this.storeThemeModel.create({
      storeId,
      themeDefinitionId: source.themeDefinitionId,
      status: 'installed',
      name: name?.trim() || `Copy of ${source.name || 'this theme'}`,
      baseThemeId: source.baseThemeId,
      theme: source.theme,
      header: source.header,
      footer: source.footer,
      identityBanner: source.identityBanner,
      customCss: source.customCss,
      draft: source.draft,
    });
    return { success: true, message: 'Theme duplicated', data: duplicate };
  }

  async renameTheme(storeId: string, sellerId: string, installedThemeId: string, name: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const updated = await this.storeThemeModel.findOneAndUpdate(
      { _id: installedThemeId, storeId },
      { $set: { name: name.trim() || null } },
      { new: true },
    );
    if (!updated) throw new NotFoundException('Installed theme not found');
    return { success: true, message: 'Theme renamed', data: updated };
  }

  /** Theme Library "Activate" — makes exactly one installed row the store's live theme. Not atomic across the two updates (this codebase doesn't use Mongo transactions elsewhere either — see `store.service.ts`), an acceptable risk for a low-frequency, single-actor-per-store admin action. */
  async activateTheme(storeId: string, sellerId: string, installedThemeId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const target = await this.storeThemeModel.findOne({ _id: installedThemeId, storeId });
    if (!target) throw new NotFoundException('Installed theme not found');
    await this.storeThemeModel.updateMany({ storeId, _id: { $ne: installedThemeId } }, { $set: { status: 'installed' } });
    target.status = 'active';
    await target.save();
    return { success: true, message: 'Theme activated', data: target };
  }

  /** Cannot uninstall the active theme — a store must always have exactly one live theme; deactivate by activating another one first. */
  async uninstallTheme(storeId: string, sellerId: string, installedThemeId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const target = await this.storeThemeModel.findOne({ _id: installedThemeId, storeId });
    if (!target) throw new NotFoundException('Installed theme not found');
    if (target.status === 'active') throw new ForbiddenException('Cannot remove the active theme — activate a different theme first');
    await target.deleteOne();
    return { success: true, message: 'Theme removed' };
  }

  // ── Existing surface — all operate on the resolved instance (active row
  // unless `installedThemeId` is given), unchanged behavior for every caller
  // that predates multi-install. ─────────────────────────────────────────

  async getForSeller(storeId: string, sellerId: string, installedThemeId?: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const theme = await this.resolveInstance(storeId, installedThemeId);
    return { success: true, data: theme };
  }

  /** Seller-only working copy, shaped like the public payload (theme/header/footer/identityBanner/baseThemeId) — what Store Builder's Theme/Header/Footer tabs edit, and what Live Preview (Phase 9) renders against real data. */
  async getDraft(storeId: string, sellerId: string, installedThemeId?: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const doc = await this.resolveInstance(storeId, installedThemeId);
    const draft = doc!.draft as StoreThemeDraft;
    return {
      success: true,
      data: {
        theme: draft.theme,
        header: draft.header,
        footer: draft.footer,
        identityBanner: draft.identityBanner,
        baseThemeId: draft.baseThemeId,
        themeDefinitionId: draft.themeDefinitionId ?? (doc as any).themeDefinitionId,
        customCss: draft.customCss,
        lastPublishedAt: doc!.lastPublishedAt,
      },
    };
  }

  // ── Preview link — a real, shareable "see this before it's live" URL.
  // See the `PreviewToken` schema's own comment for the full scope
  // boundary (theme tokens only, demo content underneath — not the
  // seller's real product catalog). ──────────────────────────────────────

  private static readonly PREVIEW_TOKEN_TTL_MS = 2 * 24 * 60 * 60 * 1000; // 2 days — matches Shopify's own unauthenticated "visitor preview" link lifetime.

  /** Mints a fresh token, replacing any previous one for this row — a
   *  seller re-sharing always gets one live link, not an ever-growing set
   *  of forgotten ones to manage. */
  async createPreviewLink(storeId: string, sellerId: string, installedThemeId?: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const instance = await this.resolveInstance(storeId, installedThemeId);
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + StoreThemeService.PREVIEW_TOKEN_TTL_MS);
    const updated = await this.storeThemeModel.findOneAndUpdate(
      { _id: instance._id },
      { $set: { previewToken: { token, expiresAt } } },
      { new: true },
    );
    return { success: true, message: 'Preview link created', data: { token, expiresAt, themeDefinitionId: updated?.themeDefinitionId ?? null } };
  }

  async revokePreviewLink(storeId: string, sellerId: string, installedThemeId?: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const instance = await this.resolveInstance(storeId, installedThemeId);
    await this.storeThemeModel.findOneAndUpdate({ _id: instance._id }, { $set: { previewToken: null } });
    return { success: true, message: 'Preview link revoked' };
  }

  /** Unauthenticated — the whole point of a preview link. Validates the
   *  token belongs to `storeId` and hasn't expired, then returns the exact
   *  same shape `getDraft` does (this row's DRAFT theme tokens) — never the
   *  full document (no `versions`, no other rows' data, no way to enumerate
   *  anything about the store beyond what this one token was minted for). */
  async getPreviewByToken(storeId: string, token: string) {
    const doc = await this.storeThemeModel.findOne({ storeId, 'previewToken.token': token }).lean();
    if (!doc || !doc.previewToken) throw new NotFoundException('Preview link not found or has expired');
    if (new Date(doc.previewToken.expiresAt).getTime() < Date.now()) {
      throw new NotFoundException('Preview link not found or has expired');
    }
    const draft = doc.draft as StoreThemeDraft;
    return {
      success: true,
      data: {
        theme: draft.theme,
        header: draft.header,
        footer: draft.footer,
        identityBanner: draft.identityBanner,
        themeDefinitionId: draft.themeDefinitionId ?? doc.themeDefinitionId,
        customCss: draft.customCss,
      },
    };
  }

  /** Unauthenticated — must never leak `draft` (unpublished edits) or
   *  `versions` (full publish history) to a public visitor. Projected to
   *  exactly the live/root fields the storefront actually reads. Resolves
   *  an attached Menu (Header's `menuId`, and now Footer's) into real
   *  blocks here (not in `getForSeller`/`getDraft`) deliberately — those two
   *  feed the seller's own Header/Footer editors, which must keep showing
   *  the RAW fallback `blocks` they actually edit/save, not a
   *  menu-substituted copy a save would otherwise silently overwrite them
   *  with. The disclosed cost: the editor's own live preview doesn't yet
   *  reflect an attached menu's real items, only the true published
   *  storefront does — a follow-up, not a correctness risk. */
  async getPublic(storeId: string) {
    const theme = await this.storeThemeModel
      .findOne({ storeId, status: 'active' }, { draft: 0, versions: 0 })
      .lean();
    if (theme?.header) {
      theme.header = await this.resolveHeaderMenu(storeId, theme.header) as any;
    }
    if (theme?.footer) {
      theme.footer = await this.resolveFooterMenu(storeId, theme.footer) as any;
    }
    return { success: true, data: theme };
  }

  /** Copies draft → the live root fields in one atomic $set via the shared ContentVersioningService (so it can't drift into a two-step read-then-write race), then appends a real version snapshot of what just went live. */
  async publishTheme(storeId: string, sellerId: string, installedThemeId?: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const instance = await this.resolveInstance(storeId, installedThemeId);
    const filter = { _id: instance._id };
    const updated = await this.contentVersioningService.publishDraft(
      this.storeThemeModel,
      filter,
      {
        theme: '$draft.theme',
        header: '$draft.header',
        footer: '$draft.footer',
        identityBanner: '$draft.identityBanner',
        baseThemeId: '$draft.baseThemeId',
        themeDefinitionId: '$draft.themeDefinitionId',
        customCss: '$draft.customCss',
      },
      { lastPublishedAt: '$$NOW' },
    );

    // Real version snapshot via the shared ContentVersioningService — a
    // separate write from the $set above (a tiny, accepted race window on a
    // low-frequency admin action) rather than forking the publish pipeline
    // just for this one caller.
    const publishedAt = (updated as any)?.lastPublishedAt ?? new Date();
    const withVersion = await this.contentVersioningService.appendVersion(
      this.storeThemeModel,
      filter,
      {
        theme: (updated as any).theme,
        header: (updated as any).header,
        footer: (updated as any).footer,
        identityBanner: (updated as any).identityBanner,
        baseThemeId: (updated as any).baseThemeId,
        themeDefinitionId: (updated as any).themeDefinitionId,
        customCss: (updated as any).customCss,
        publishedAt,
      },
    );

    return { success: true, message: 'Theme published', data: withVersion ?? updated };
  }

  async listVersions(storeId: string, sellerId: string, installedThemeId?: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const instance = await this.resolveInstance(storeId, installedThemeId);
    const versions = await this.contentVersioningService.listVersions(this.storeThemeModel, { _id: instance._id });
    return { success: true, data: versions };
  }

  /** Restores a past version into the DRAFT slot for review — mirrors this
   *  file's other draft-mutating flows (never writes straight to live). The
   *  seller still has to explicitly hit Publish afterward, same as any
   *  other draft edit — a restore is not a silent instant rollback. */
  async restoreVersion(storeId: string, sellerId: string, versionId: string, installedThemeId?: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const instance = await this.resolveInstance(storeId, installedThemeId);
    const filter = { _id: instance._id };
    const version = await this.contentVersioningService.findVersion(this.storeThemeModel, filter, versionId);
    if (!version) throw new BadRequestException('Version not found');

    const updated = await this.contentVersioningService.restoreVersionToDraft(this.storeThemeModel, filter, {
      'draft.theme': version.theme,
      'draft.header': version.header,
      'draft.footer': version.footer,
      'draft.identityBanner': version.identityBanner,
      'draft.baseThemeId': version.baseThemeId,
      'draft.themeDefinitionId': version.themeDefinitionId,
      'draft.customCss': version.customCss,
    });
    return { success: true, message: 'Version restored to draft — review and publish to make it live.', data: updated };
  }

  /** Safety-net "discard unsaved changes" — copies the live root fields back over draft, the mirror image of publishTheme's copy direction. */
  async revertDraftToPublished(storeId: string, sellerId: string, installedThemeId?: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const instance = await this.resolveInstance(storeId, installedThemeId);
    const updated = await this.contentVersioningService.revertDraft(this.storeThemeModel, { _id: instance._id }, {
      draft: {
        theme: '$theme',
        header: '$header',
        footer: '$footer',
        identityBanner: '$identityBanner',
        baseThemeId: '$baseThemeId',
        themeDefinitionId: '$themeDefinitionId',
        customCss: '$customCss',
      },
    });
    return { success: true, message: 'Draft reverted to the published theme', data: updated };
  }

  async updateTheme(storeId: string, sellerId: string, dto: UpdateThemeDto, installedThemeId?: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const instance = await this.resolveInstance(storeId, installedThemeId);
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value === undefined) continue;
      // `baseThemeId` lives at the draft root (sibling of `theme`), not
      // nested under it — everything else on this DTO is a `theme.*`
      // color/design field. All writes now target `draft.*`, never the
      // live root fields directly — see publishTheme() for how a draft
      // actually goes live.
      set[key === 'baseThemeId' ? 'draft.baseThemeId' : `draft.theme.${key}`] = value;
    }
    const updated = await this.storeThemeModel.findOneAndUpdate({ _id: instance._id }, { $set: set }, { new: true });
    return { success: true, message: 'Theme updated', data: updated };
  }

  // ── Color Schemes — named, reusable saved palettes (see the class comment
  // on `ColorScheme` for the scope boundary: applying one overwrites the
  // theme's own live bgColor/textColor/primaryColor, it isn't a per-section
  // assignment). ──────────────────────────────────────────────────────────

  private static readonly MAX_COLOR_SCHEMES = 20;

  async createColorScheme(storeId: string, sellerId: string, dto: CreateColorSchemeDto, installedThemeId?: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const instance = await this.resolveInstance(storeId, installedThemeId);
    const existing = (instance.draft?.theme?.colorSchemes ?? []) as { id: string }[];
    if (existing.length >= StoreThemeService.MAX_COLOR_SCHEMES) {
      throw new BadRequestException(`Cannot save more than ${StoreThemeService.MAX_COLOR_SCHEMES} color schemes`);
    }
    const scheme = { id: new Types.ObjectId().toString(), name: dto.name, bgColor: dto.bgColor, textColor: dto.textColor, primaryColor: dto.primaryColor };
    const updated = await this.storeThemeModel.findOneAndUpdate(
      { _id: instance._id },
      { $push: { 'draft.theme.colorSchemes': scheme } },
      { new: true },
    );
    return { success: true, message: 'Color scheme saved', data: updated };
  }

  async deleteColorScheme(storeId: string, sellerId: string, schemeId: string, installedThemeId?: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const instance = await this.resolveInstance(storeId, installedThemeId);
    const updated = await this.storeThemeModel.findOneAndUpdate(
      { _id: instance._id },
      { $pull: { 'draft.theme.colorSchemes': { id: schemeId } } },
      { new: true },
    );
    return { success: true, message: 'Color scheme deleted', data: updated };
  }

  /** Copies a saved scheme's 3 colors onto the theme's own live draft
   *  fields — the exact same fields the Theme Settings color pickers write
   *  to directly, so this needs no new rendering logic anywhere: publishing
   *  afterward makes it live exactly like any other Theme Settings edit. */
  async applyColorScheme(storeId: string, sellerId: string, schemeId: string, installedThemeId?: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const instance = await this.resolveInstance(storeId, installedThemeId);
    const scheme = ((instance.draft?.theme?.colorSchemes ?? []) as { id: string; bgColor: string; textColor: string; primaryColor: string }[])
      .find(s => s.id === schemeId);
    if (!scheme) throw new NotFoundException('Color scheme not found');
    const updated = await this.storeThemeModel.findOneAndUpdate(
      { _id: instance._id },
      { $set: {
        'draft.theme.bgColor': scheme.bgColor,
        'draft.theme.textColor': scheme.textColor,
        'draft.theme.primaryColor': scheme.primaryColor,
      } },
      { new: true },
    );
    return { success: true, message: 'Color scheme applied to draft', data: updated };
  }

  async updateHeader(storeId: string, sellerId: string, dto: UpdateHeaderDto, installedThemeId?: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const instance = await this.resolveInstance(storeId, installedThemeId);
    if (dto.blocks) validateBlocks(dto.blocks, HEADER_ALLOWED_BLOCK_TYPES, MAX_HEADER_LINKS);

    const set: Record<string, unknown> = {};
    if (dto.logoSource !== undefined) set['draft.header.logoSource'] = dto.logoSource;
    if (dto.customLogoUrl !== undefined) set['draft.header.customLogoUrl'] = dto.customLogoUrl;
    if (dto.blocks !== undefined) set['draft.header.blocks'] = dto.blocks;
    if (dto.navAlignment !== undefined) set['draft.header.navAlignment'] = dto.navAlignment;
    if (dto.headerStyle !== undefined) set['draft.header.headerStyle'] = dto.headerStyle;
    if (dto.menuId !== undefined) set['draft.header.menuId'] = dto.menuId;

    const updated = await this.storeThemeModel.findOneAndUpdate({ _id: instance._id }, { $set: set }, { new: true });
    return { success: true, message: 'Header updated', data: updated };
  }

  async updateFooter(storeId: string, sellerId: string, dto: UpdateFooterDto, installedThemeId?: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const instance = await this.resolveInstance(storeId, installedThemeId);
    validateBlocks(dto.blocks, FOOTER_ALLOWED_BLOCK_TYPES, MAX_FOOTER_BLOCKS);

    const set: Record<string, unknown> = { 'draft.footer.blocks': dto.blocks };
    if (dto.footerStyle !== undefined) set['draft.footer.footerStyle'] = dto.footerStyle;

    const updated = await this.storeThemeModel.findOneAndUpdate({ _id: instance._id }, { $set: set }, { new: true });
    return { success: true, message: 'Footer updated', data: updated };
  }

  async updateIdentityBanner(storeId: string, sellerId: string, dto: UpdateIdentityBannerDto, installedThemeId?: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const instance = await this.resolveInstance(storeId, installedThemeId);
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined) set[`draft.identityBanner.${key}`] = value;
    }
    const updated = await this.storeThemeModel.findOneAndUpdate({ _id: instance._id }, { $set: set }, { new: true });
    return { success: true, message: 'Store info updated', data: updated };
  }

  // ── Advanced theme authoring — real, bounded developer capability ────────
  // (see the class comment on `StoreTheme.customCss` for the full safety
  // rationale: CSS-only, no custom JS, no arbitrary section-type/template
  // authoring — the boundary this codebase can actually make safe today).

  async updateCustomCss(storeId: string, sellerId: string, customCss: string | null, installedThemeId?: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const instance = await this.resolveInstance(storeId, installedThemeId);
    const validated = validateCustomCss(customCss);
    const updated = await this.storeThemeModel.findOneAndUpdate(
      { _id: instance._id },
      { $set: { 'draft.customCss': validated } },
      { new: true },
    );
    return { success: true, message: 'Custom CSS updated', data: updated };
  }
}
