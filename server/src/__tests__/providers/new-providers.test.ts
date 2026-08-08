import { describe, expect, it } from 'vitest';
import { getProvider, hasProvider } from '../../providers/index.js';

describe('ModelScope, SEA-LION, and NavyAI providers', () => {
  it('registers all three providers with model discovery', () => {
    for (const platform of ['modelscope', 'sealion', 'navy'] as const) {
      expect(hasProvider(platform)).toBe(true);
      const provider = getProvider(platform);
      expect(provider).toBeDefined();
      const request = provider!.getModelCatalogRequest('TOKEN');
      expect(request?.url).toContain('/models');
      expect(request?.headers?.Authorization).toBe('Bearer TOKEN');
    }
  });

  it('keeps NavyAI’s required request header', () => {
    const request = getProvider('navy')!.getModelCatalogRequest('TOKEN');
    expect(request?.headers?.['User-Agent']).toBe('FreeLLMAPI/1.0');
  });

  it('uses the first-party endpoints', () => {
    expect(getProvider('modelscope')!.getModelCatalogRequest('TOKEN')?.url)
      .toBe('https://api-inference.modelscope.cn/v1/models');
    expect(getProvider('sealion')!.getModelCatalogRequest('TOKEN')?.url)
      .toBe('https://api.sea-lion.ai/v1/models');
    expect(getProvider('navy')!.getModelCatalogRequest('TOKEN')?.url)
      .toBe('https://api.navy/v1/models');
  });
});
