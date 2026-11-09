/* eslint-disable prettier/prettier */
import { ImageEnhanceService } from './providers/image-enhance.service';
import { AiStudioService } from './ai-studio.service';

const cfg = (v?: string) => ({ get: () => v }) as any;

describe('Image Enhancer honesty', () => {
  it('the stub provider is reported as not available and refuses before anything else', () => {
    const s = new ImageEnhanceService(cfg());
    expect(s.isAvailable).toBe(false);
    expect(() => s.assertAvailable()).toThrow(/not available yet/);
  });

  it('starting an enhancement with the stub never verifies the store, holds credits or creates a generation', async () => {
    const calls: string[] = [];
    const svc: any = Object.create(AiStudioService.prototype);
    svc.imageEnhance = new ImageEnhanceService(cfg('stub'));
    svc.verifyStore = async () => { calls.push('verifyStore'); };
    svc.createGeneration = async () => { calls.push('createGeneration'); };
    svc.holdOrFailGeneration = async () => { calls.push('hold'); };
    await expect(svc.startImageEnhance('seller', 'store', { imageUrl: 'https://x/y.jpg', enhancementType: 'upscale' })).rejects.toThrow(/No credits were used/);
    expect(calls).toEqual([]);
  });

  it('the credits overview tells the UI the tool is unavailable', async () => {
    const svc: any = Object.create(AiStudioService.prototype);
    svc.imageEnhance = new ImageEnhanceService(cfg());
    svc.verifyStore = async () => undefined;
    svc.credits = { getCreditsOverview: async () => ({ success: true, data: { balance: 5 } }) };
    const r = await svc.getCredits('seller', 'store');
    expect(r.data).toEqual({ balance: 5, imageEnhancerAvailable: false });
  });
});
