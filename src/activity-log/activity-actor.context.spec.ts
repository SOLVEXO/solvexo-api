/* eslint-disable prettier/prettier */
import { requestActor, resolveActor } from './activity-actor.context';

describe('resolveActor — staff acting for an owner', () => {
  const owner = 'owner1';
  const run = <T,>(ctx: { userId: string; role: string; sellerId: string | null }, fn: () => T) => requestActor.run(ctx, fn);

  it('records the staff member instead of the owner when the owner id was passed as actor', () => {
    const out = run({ userId: 'staff9', role: 'staff', sellerId: owner }, () => resolveActor({ actorId: owner, actorRole: 'seller' }));
    expect(out).toEqual({ actorId: 'staff9', actorRole: 'staff' });
  });

  it('leaves a real owner action alone', () => {
    const out = run({ userId: owner, role: 'seller', sellerId: null }, () => resolveActor({ actorId: owner, actorRole: 'seller' }));
    expect(out).toEqual({ actorId: owner, actorRole: 'seller' });
  });

  it('never rewrites an entry about somebody else (a different actor id)', () => {
    const out = run({ userId: 'staff9', role: 'staff', sellerId: owner }, () => resolveActor({ actorId: 'someone-else', actorRole: 'user' }));
    expect(out.actorId).toBe('someone-else');
  });

  it('does nothing outside a request (cron / webhook)', () => {
    expect(resolveActor({ actorId: owner, actorRole: 'seller' })).toEqual({ actorId: owner, actorRole: 'seller' });
  });
});
