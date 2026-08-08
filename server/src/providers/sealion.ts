import { OpenAICompatProvider } from './openai-compat.js';

/** SEA-LION (AI Singapore) first-party OpenAI-compatible API. */
export class SeaLionProvider extends OpenAICompatProvider {
  constructor() {
    super({
      platform: 'sealion',
      name: 'SEA-LION',
      baseUrl: 'https://api.sea-lion.ai/v1',
    });
  }
}
