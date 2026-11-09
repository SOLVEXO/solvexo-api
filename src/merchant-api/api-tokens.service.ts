/* eslint-disable prettier/prettier */
import { BadRequestException, CanActivate, ExecutionContext, HttpException, Injectable, NotFoundException, SetMetadata, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ApiToken, ApiTokenDocument } from './merchant-api.schema';
import { API_SCOPES, generateToken, hashToken, makeRateLimiter, scopeAllows, validScopes, type ApiScope } from './merchant-api.util';

const MAX_TOKENS = 20;

@Injectable()
export class ApiTokensService {
  constructor(@InjectModel(ApiToken.name) readonly tokens: Model<ApiTokenDocument>, private readonly activity: ActivityLogService) {}

  private audit(storeId: string, actor: { id: string; role: string }, action: string, description: string, targetId: string) {
    return this.activity.log({ storeId, category: 'api_tokens', action, description, actorId: actor.id, actorRole: actor.role, targetId, targetType: 'api_token' } as any).catch(() => undefined);
  }

  async list(storeId: string) { return { scopes: API_SCOPES, items: await this.tokens.find({ storeId }).select('-tokenHash').sort({ createdAt: -1 }).lean() }; }

  /** The plain token is returned ONCE here; only its hash is kept. */
  async create(storeId: string, actor: { id: string; role: string }, body: any) {
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
    if (!name) throw new BadRequestException('Give the token a name');
    const scopes = validScopes(body?.scopes); if (!scopes) throw new BadRequestException('Choose at least one valid permission');
    if ((await this.tokens.countDocuments({ storeId, revokedAt: null })) >= MAX_TOKENS) throw new BadRequestException(`At most ${MAX_TOKENS} active tokens per store`);
    const t = generateToken();
    const doc = await this.tokens.create({ storeId, name, tokenHash: t.hash, prefix: t.prefix, scopes, createdBy: actor.id });
    void this.audit(storeId, actor, 'api_token_created', `Token "${name}" created (${scopes.join(', ')})`, String(doc._id));
    return { id: String(doc._id), token: t.token, prefix: t.prefix, scopes };
  }

  async revoke(storeId: string, actor: { id: string; role: string }, id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Token not found');
    const r = await this.tokens.findOneAndUpdate({ _id: id, storeId, revokedAt: null }, { $set: { revokedAt: new Date() } }, { new: true }).lean();
    if (!r) throw new NotFoundException('Token not found or already revoked');
    void this.audit(storeId, actor, 'api_token_revoked', `Token "${r.name}" revoked`, id);
    return { success: true };
  }
}

export const API_SCOPE_KEY = 'merchantApiScope';
export const NeedsApiScope = (scope: ApiScope) => SetMetadata(API_SCOPE_KEY, scope);
const limiter = makeRateLimiter(120, 60_000);

/** Bearer `sxk_...` token auth for the merchant API. Sets `req.apiToken = { storeId, scopes }`; the store comes from the token, never from the client. */
@Injectable()
export class ApiTokenGuard implements CanActivate {
  constructor(private readonly svc: ApiTokensService, private readonly reflector: Reflector) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const m = /^Bearer (sxk_[0-9a-f]{40})$/.exec(String(req.headers?.authorization ?? ''));
    if (!m) throw new UnauthorizedException('Missing or malformed API token');
    const tok: any = await this.svc.tokens.findOne({ tokenHash: hashToken(m[1]), revokedAt: null }).lean();
    if (!tok) throw new UnauthorizedException('Invalid API token');
    if (!limiter(String(tok._id))) throw new HttpException('Too many requests', 429);
    const needed = this.reflector.get<ApiScope | undefined>(API_SCOPE_KEY, ctx.getHandler());
    if (needed && !scopeAllows(tok.scopes, needed)) throw new ForbiddenException(`This token does not have the "${needed}" permission`);
    if (!tok.lastUsedAt || Date.now() - new Date(tok.lastUsedAt).getTime() > 60_000) void this.svc.tokens.updateOne({ _id: tok._id }, { $set: { lastUsedAt: new Date() } }).catch(() => undefined);
    req.apiToken = { storeId: String(tok.storeId), scopes: tok.scopes };
    return true;
  }
}
