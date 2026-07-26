import { describe, it, expect } from 'vitest';
import {
  isValidUserPlatformSlug,
  isReservedPlatformSlug,
  rememberUserPlatform,
  isUserPlatform,
} from '../../providers/index.js';

describe('user platform slugs', () => {
  it('accepts a slug that starts with a digit', () => {
    // Providers do get named this way (01ai, 302ai), and rejecting them left
    // those keys unaddable.
    expect(isValidUserPlatformSlug('01ai')).toBe(true);
    expect(isValidUserPlatformSlug('302ai')).toBe(true);
    expect(isValidUserPlatformSlug('4everai')).toBe(true);
  });

  it('accepts the ordinary letter-led forms', () => {
    expect(isValidUserPlatformSlug('mapleleaf')).toBe(true);
    expect(isValidUserPlatformSlug('free-llmcups')).toBe(true);
    expect(isValidUserPlatformSlug('my.host/v1')).toBe(true);
    expect(isValidUserPlatformSlug('a_b-c.d/e')).toBe(true);
    expect(isValidUserPlatformSlug('a')).toBe(true);
  });

  it('still refuses punctuation-led, empty, over-long and illegal slugs', () => {
    for (const bad of ['_lead', '-lead', '.lead', '/lead', '']) {
      expect(isValidUserPlatformSlug(bad)).toBe(false);
    }
    expect(isValidUserPlatformSlug('a'.repeat(32))).toBe(true);
    expect(isValidUserPlatformSlug('a'.repeat(33))).toBe(false);
    for (const bad of ['has space', 'hash#tag', 'colon:port', 'plus+one', 'q?uery']) {
      expect(isValidUserPlatformSlug(bad)).toBe(false);
    }
  });

  it('keeps built-in and retired slugs reserved', () => {
    for (const slug of ['groq', 'google', 'custom', 'sambanova']) {
      expect(isReservedPlatformSlug(slug)).toBe(true);
    }
    expect(isReservedPlatformSlug('01ai')).toBe(false);
  });

  it('registers a digit-led slug, lowercased, and never a reserved one', () => {
    rememberUserPlatform('  01AI  ');
    expect(isUserPlatform('01ai')).toBe(true);
    // Callers lowercase before validating, so the stored form is lowercase.
    expect(isUserPlatform('01AI')).toBe(false);

    rememberUserPlatform('groq');
    expect(isUserPlatform('groq')).toBe(false);

    rememberUserPlatform('_nope');
    expect(isUserPlatform('_nope')).toBe(false);
  });
});
