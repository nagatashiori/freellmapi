import { OpenAICompatProvider } from './openai-compat.js';

/** NavyAI unified API; its edge requires an explicit User-Agent. */
export class NavyProvider extends OpenAICompatProvider {
  constructor() {
    super({
      platform: 'navy',
      name: 'NavyAI',
      baseUrl: 'https://api.navy/v1',
      extraHeaders: {
        'User-Agent': 'FreeLLMAPI/1.0',
      },
    });
  }
}
