import { OpenAICompatProvider } from './openai-compat.js';
import { recordQuotaObservationsFromResponse, type QuotaObservationContext } from '../services/provider-quota.js';

const MODELSCOPE_BASE_URL = 'https://api-inference.modelscope.cn/v1';

/**
 * ModelScope's /models endpoint is public and does not prove that a token is
 * valid. Pick a live model from that catalog, then make the smallest possible
 * authenticated chat request for key validation.
 */
export class ModelScopeProvider extends OpenAICompatProvider {
  constructor() {
    super({
      platform: 'modelscope',
      name: 'ModelScope',
      baseUrl: MODELSCOPE_BASE_URL,
      timeoutMs: 90_000,
    });
  }

  override async validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<boolean> {
    if (!apiKey || apiKey === 'no-key') return false;

    const modelsRes = await this.fetchWithTimeout(`${MODELSCOPE_BASE_URL}/models`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    }, 30_000);

    if (!modelsRes.ok) {
      throw new Error(`ModelScope /models returned HTTP ${modelsRes.status} while picking a validation probe model`);
    }

    const roster = await modelsRes.json().catch(() => null) as { data?: Array<{ id?: string }> } | null;
    const probeModel = roster?.data?.[0]?.id;
    if (!probeModel) throw new Error('ModelScope /models returned no models to probe key validity against');

    const res = await this.fetchWithTimeout(`${MODELSCOPE_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: probeModel,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
    }, 30_000);

    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId: probeModel,
      quotaPoolKey: quotaContext?.quotaPoolKey,
      endpoint: 'chat/completions',
    });

    if (res.status === 401 || res.status === 403) return false;
    if (res.status >= 500) throw new Error(`ModelScope validateKey HTTP ${res.status}`);
    return true;
  }
}
