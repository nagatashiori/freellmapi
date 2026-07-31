import { describe, expect, it } from 'vitest';
import { niceDisplayName } from '../../lib/model-intel.js';

describe('niceDisplayName', () => {
  it('does not assign every Kimi family member to Kimi K2.6', () => {
    expect(niceDisplayName('kimi-k2-7-code')).toBe('Kimi K2-7 Code');
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
});
