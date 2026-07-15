import { describe, it, expect, beforeEach } from 'vitest';
import { initDb } from '../../db/index.js';
import {
  classifyClaudeFamily,
  getClaudeModelMap,
  resolveAnthropicModel,
  setClaudeModelMap,
} from '../../services/anthropic-map.js';

// classifyClaudeFamily maps a requested model alias to a Claude family (or null
// for a concrete catalog id). Claude Code's planning alias `opusplan` is
// opus-ish by name, but the operator map has no `opusplan` slot — it must fall
// through to the `default` family, as the function's own comment states.
describe('classifyClaudeFamily', () => {
  it('routes Claude Code opusplan aliases to the default family', () => {
    expect(classifyClaudeFamily('opusplan')).toBe('default');
    expect(classifyClaudeFamily('opusplan-4')).toBe('default');
    expect(classifyClaudeFamily('OpusPlan')).toBe('default');
  });

  it('still classifies real opus models as the opus family', () => {
    expect(classifyClaudeFamily('opus')).toBe('opus');
    expect(classifyClaudeFamily('claude-opus-4-1')).toBe('opus');
  });

  it('classifies the other Claude families and aliases as before', () => {
    expect(classifyClaudeFamily('claude-sonnet-4-5')).toBe('sonnet');
    expect(classifyClaudeFamily('claude-3-5-haiku')).toBe('haiku');
    expect(classifyClaudeFamily('claude-something-new')).toBe('default');
    expect(classifyClaudeFamily('')).toBe('default');
    expect(classifyClaudeFamily('auto')).toBe('default');
  });

  it('returns null for a non-Claude concrete catalog id', () => {
    expect(classifyClaudeFamily('llama-3.1-70b')).toBeNull();
  });
});

describe('resolveAnthropicModel auto:<profile> map values', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('honors auto:high/mid/light when stored in the family map', () => {
    setClaudeModelMap({
      default: 'auto:high',
      opus: 'auto:high',
      sonnet: 'auto:mid',
      haiku: 'auto:light',
    });
    expect(getClaudeModelMap()).toMatchObject({
      default: 'auto:high',
      opus: 'auto:high',
      sonnet: 'auto:mid',
      haiku: 'auto:light',
    });

    // Claude Code sends family model names; map must yield profileName, not
    // silent fall-through to active Default (the pre-fix bug).
    expect(resolveAnthropicModel('claude-opus-4-5')).toEqual({
      pinned: false,
      profileName: 'high',
    });
    expect(resolveAnthropicModel('claude-sonnet-4-5')).toEqual({
      pinned: false,
      profileName: 'mid',
    });
    expect(resolveAnthropicModel('claude-haiku-4-5')).toEqual({
      pinned: false,
      profileName: 'light',
    });
    expect(resolveAnthropicModel('claude-something')).toEqual({
      pinned: false,
      profileName: 'high',
    });
  });

  it('still accepts a direct auto:high request model', () => {
    expect(resolveAnthropicModel('auto:high')).toEqual({
      pinned: false,
      profileName: 'high',
    });
  });

  it('plain auto stays unpinned without a profileName', () => {
    setClaudeModelMap({ default: 'auto', opus: 'auto', sonnet: 'auto', haiku: 'auto' });
    expect(resolveAnthropicModel('claude-opus-4-5')).toEqual({ pinned: false });
  });
});
