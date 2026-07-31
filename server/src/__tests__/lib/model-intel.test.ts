import { describe, expect, it } from 'vitest';
import { niceDisplayName, repairLegacyDisplayName } from '../../lib/model-intel.js';

describe('niceDisplayName', () => {
  it('does not assign every Kimi family member to Kimi K2.6', () => {
    expect(niceDisplayName('kimi-k2-7-code')).toBe('Kimi 2.7 Coding');
    expect(niceDisplayName('kimi-k2-instruct')).toBe('Kimi K2 Instruct');
    expect(niceDisplayName('kimi-k3')).toBe('Kimi K3');
    expect(niceDisplayName('kimi-k3-fast')).toBe('Kimi K3 Fast');
    expect(niceDisplayName('kimi-k3-instruct')).toBe('Kimi K3 Instruct');
  });

  it('keeps exact known Kimi aliases mapped to their canonical labels', () => {
    expect(niceDisplayName('moonshotai/Kimi-K2.6')).toBe('Kimi K2.6');
    expect(niceDisplayName('kimi-k2-7')).toBe('Kimi K2.7');
  });

  it('preserves numeric version hyphens in generic Claude labels', () => {
    expect(niceDisplayName('claude-fable-5')).toBe('Claude Fable 5');
    expect(niceDisplayName('claude-opus-4')).toBe('Claude Opus 4');
    expect(niceDisplayName('claude-opus-4-1')).toBe('Claude Opus 4-1');
    expect(niceDisplayName('claude-opus-4-8')).toBe('Claude Opus 4-8');
  });

  it('keeps MiniMax model families separate by numeric version', () => {
    expect(niceDisplayName('minimax-m3')).toBe('MiniMax M3');
    expect(niceDisplayName('minimax-m2.7')).toBe('MiniMax M2.7');
    expect(niceDisplayName('minimax-m2.5')).toBe('MiniMax M2.5');
    expect(niceDisplayName('minimax-m2')).toBe('MiniMax M2');
    expect(niceDisplayName('minimax-m2.5-lightning')).toBe('MiniMax M2.5 Lightning');
  });

  it('uses canonical Nemotron and GLM numeric labels', () => {
    expect(niceDisplayName('nvidia/nemotron-3-super-120b-a12b-20230311:free')).toBe('Nemotron 3 Super');
    expect(niceDisplayName('glm-4.7-flash')).toBe('GLM 4.7 Flash');
    expect(niceDisplayName('glm-4.7')).toBe('GLM 4.7');
    expect(niceDisplayName('glm-5.1')).toBe('GLM 5.1');
    expect(niceDisplayName('glm-5')).toBe('GLM 5');
    expect(niceDisplayName('glm-5.2')).toBe('GLM 5.2');
  });

  it('groups Kimi for Coding under Kimi 2.7 Coding', () => {
    expect(niceDisplayName('kimi-for-coding')).toBe('Kimi 2.7 Coding');
    expect(niceDisplayName('kimi-k2.7-code')).toBe('Kimi 2.7 Coding');
    expect(niceDisplayName('kimi-k2-7-code:free')).toBe('Kimi 2.7 Coding');
  });

  it('repairs stored labels created by the old broad rules', () => {
    expect(repairLegacyDisplayName('minimax-m3', 'MiniMax')).toBe('MiniMax M3');
    expect(repairLegacyDisplayName('minimax-m2.5', 'MiniMax')).toBe('MiniMax M2.5');
    expect(repairLegacyDisplayName('glm-4.7-flash', 'Glm 4.7 Flash')).toBe('GLM 4.7 Flash');
    expect(repairLegacyDisplayName('nvidia/nemotron-3-super-120b-a12b:free', 'Nemotron 3 Super 120b A12b Free')).toBe('Nemotron 3 Super');
    expect(repairLegacyDisplayName('kimi-for-coding', 'Kimi For Coding')).toBe('Kimi 2.7 Coding');
  });

  it('repairs old generated labels without changing explicit operator labels', () => {
    expect(repairLegacyDisplayName('kimi-k3-instruct', 'Kimi K2.6')).toBe('Kimi K3 Instruct');
    expect(repairLegacyDisplayName('kimi-k2-7-code', 'Kimi K2.7')).toBe('Kimi 2.7 Coding');
    expect(repairLegacyDisplayName('claude-opus-4-1', 'Claude Opus 4 1')).toBe('Claude Opus 4-1');
    expect(repairLegacyDisplayName('kimi-k3', 'Operator Label')).toBe('Operator Label');
    expect(repairLegacyDisplayName('kimi-k2.6', 'Kimi K2.6')).toBe('Kimi K2.6');
  });

  it('repairs old labels with provider suffixes and outdated Kimi coding variants', () => {
    // Cloudflare variant: stored with "(CF)" suffix and old "K2.7 Code" spelling
    expect(repairLegacyDisplayName('@cf/moonshotai/kimi-k2.7-code', 'Kimi K2.7 Code (CF)')).toBe('Kimi 2.7 Coding');
    // Generic old spelling without suffix
    expect(repairLegacyDisplayName('kimi-k2.7-code', 'Kimi K2.7 Code')).toBe('Kimi 2.7 Coding');
    // kimi-for-coding with provider suffix
    expect(repairLegacyDisplayName('kimi-for-coding', 'Kimi For Coding (MapleLeaf)')).toBe('Kimi 2.7 Coding');
    // Explicit operator label is still preserved for unrelated identities
    expect(repairLegacyDisplayName('kimi-k3-fast', 'My Custom Kimi')).toBe('My Custom Kimi');
  });

  it('keeps Claude Opus version rows separate instead of labeling them 4.8', () => {
    // catalog sync persisted "Claude Opus 4.8" on every claude-opus-4-N id; the
    // label must follow the id's own version so 4-6/4-7 stop collapsing into 4.8.
    expect(niceDisplayName('claude-opus-4-6')).toBe('Claude Opus 4-6');
    expect(niceDisplayName('claude-opus-4-7')).toBe('Claude Opus 4-7');
    expect(repairLegacyDisplayName('claude-opus-4-6', 'Claude Opus 4.8')).toBe('Claude Opus 4-6');
    expect(repairLegacyDisplayName('claude-opus-4-7', 'Claude Opus 4.8')).toBe('Claude Opus 4-7');
    expect(repairLegacyDisplayName('claude-opus-4-8', 'Claude Opus 4.8')).toBe('Claude Opus 4-8');
  });

  it('keeps Claude Sonnet 4 rows out of the Claude Sonnet 4.5 group', () => {
    expect(repairLegacyDisplayName('claude-sonnet-4-20250514-thinking', 'Claude Sonnet 4.5')).toBe('Claude Sonnet 4-20250514 Thinking');
    expect(repairLegacyDisplayName('claude-sonnet-4-thinking', 'Claude Sonnet 4.5')).toBe('Claude Sonnet 4 Thinking');
    // A genuine 4.5 id keeps its correct stored label.
    expect(repairLegacyDisplayName('claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5')).toBe('Claude Sonnet 4.5');
  });

  it('repairs GLM vision ids labeled as plain GLM 4.6', () => {
    expect(repairLegacyDisplayName('glm-4.6v-flash', 'GLM-4.6')).toBe('GLM 4.6V Flash');
    expect(repairLegacyDisplayName('GLM-4.6-V', 'GLM-4.6')).toBe('GLM 4.6 V');
    expect(repairLegacyDisplayName('glm-4.6v', 'GLM-4.6')).toBe('GLM 4.6V');
    expect(niceDisplayName('glm-4.6v-thinking-search')).toBe('GLM 4.6V Thinking Search');
    // A true GLM 4.6 text row keeps the canonical text label.
    expect(repairLegacyDisplayName('glm-4.6', 'GLM-4.6')).toBe('GLM 4.6');
  });

  it('labels compact MiniMax ids without the "-m" separator', () => {
    expect(niceDisplayName('minimax2.7')).toBe('MiniMax M2.7');
    expect(repairLegacyDisplayName('minimax2.7', 'MiniMax')).toBe('MiniMax M2.7');
    expect(repairLegacyDisplayName('minimax-m2.7', 'MiniMax')).toBe('MiniMax M2.7');
  });

  it('keeps o1/o3/GPT spec variants out of the base-version group', () => {
    expect(repairLegacyDisplayName('o1-mini', 'o1')).toBe('O1 Mini');
    expect(repairLegacyDisplayName('o3-pro', 'o3')).toBe('O3 Pro');
    expect(repairLegacyDisplayName('gpt-5-3-mini', 'GPT-5.3')).toBe('Gpt 5-3 Mini');
    expect(repairLegacyDisplayName('gpt-5.4-nano', 'GPT-5.4')).toBe('Gpt 5.4 Nano');
    // base version rows keep their stored label
    expect(repairLegacyDisplayName('o1', 'o1')).toBe('O1');
    expect(repairLegacyDisplayName('o3', 'o3')).toBe('O3');
  });

  it('keeps Llama 3.2 sizes separate instead of one shared label', () => {
    expect(repairLegacyDisplayName('llama-3.2-1b-instruct', 'Llama 3.2')).toBe('Llama 3.2 1B');
    expect(repairLegacyDisplayName('llama-3.2-11b-vision-instruct', 'Llama 3.2')).toBe('Llama 3.2 11B Vision');
  });

  it('repairs Hunyuan OCR/MT and Qwen2.5-Coder labels folded into other groups', () => {
    expect(repairLegacyDisplayName('HunyuanOCR', 'Hunyuan Hy3')).toBe('Hunyuan OCR');
    expect(repairLegacyDisplayName('Hunyuan-MT-7B', 'Hunyuan Hy3')).toBe('Hunyuan MT 7B');
    expect(repairLegacyDisplayName('qwen2.5-coder-32b', 'Qwen3 Coder')).toBe('Qwen2.5 Coder 32b');
  });
});
