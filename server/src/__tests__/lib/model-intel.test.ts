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
});
