import { describe, it, expect } from 'vitest';
import {
  stripProviderSuffix,
  normalizeGroupKey,
  slugifyGroupLabel,
  groupRows,
  resolveRequestedIdToMembers,
  type GroupableRow,
  type UnifyOverrides,
} from '../../services/model-groups.js';
import { niceDisplayName } from '../../lib/model-intel.js';

const NO_OVERRIDES: UnifyOverrides = { merges: [], splits: [] };

function row(model_db_id: number, platform: string, model_id: string, display_name: string, intelligence_rank = 50): GroupableRow {
  return { model_db_id, platform, model_id, display_name, intelligence_rank };
}

// A realistic slice of the catalog: the same logical models under many providers
// with the mixed naming the real migrations use.
function catalog(): GroupableRow[] {
  return [
    row(1, 'cerebras', 'gpt-oss-120b', 'GPT-OSS 120B', 3),
    row(2, 'groq', 'openai/gpt-oss-120b', 'GPT-OSS 120B (Groq)', 6),
    row(3, 'cloudflare', '@cf/openai/gpt-oss-120b', 'GPT-OSS 120B (CF)', 6),
    row(4, 'sambanova', 'gpt-oss-120b', 'GPT-OSS 120B (SambaNova)', 6),
    row(5, 'ollama', 'gpt-oss:120b', 'GPT-OSS 120B (Ollama)', 9),
    row(6, 'groq', 'llama-3.3-70b-versatile', 'Llama 3.3 70B', 9),
    row(7, 'openrouter', 'meta-llama/llama-3.3-70b-instruct:free', 'Llama 3.3 70B (free)', 17),
    row(8, 'huggingface', 'accounts/fireworks/models/llama-v3p3-70b-instruct', 'Llama 3.3 70B (HF)', 14),
    row(9, 'cloudflare', '@cf/meta/llama-3.3-70b-fp8-fast', 'Llama 3.3 70B fp8-fast (CF)', 12),
  ];
}

describe('stripProviderSuffix', () => {
  it('strips known provider/variant parentheticals', () => {
    for (const tag of ['Groq', 'CF', 'HF', 'NV', 'SambaNova', 'Ollama', 'Cerebras', 'GitHub', 'free']) {
      expect(stripProviderSuffix(`Llama 3.3 70B (${tag})`)).toBe('Llama 3.3 70B');
    }
  });
  it('strips a generic trailing parenthetical too', () => {
    expect(stripProviderSuffix('Some Model (whatever)')).toBe('Some Model');
  });
  it('leaves names without a trailing parenthetical alone', () => {
    expect(stripProviderSuffix('GPT-OSS 120B')).toBe('GPT-OSS 120B');
  });
});

describe('normalizeGroupKey', () => {
  it('lowercases, strips suffix, and treats hyphens/underscores/space as one separator', () => {
    expect(normalizeGroupKey('GPT-OSS 120B (Groq)')).toBe('gpt oss 120b');
    expect(normalizeGroupKey('  Llama  3.3   70B  (HF) ')).toBe('llama 3.3 70b');
    // Separator-only spelling differences normalize to the same key…
    expect(normalizeGroupKey('Qwen3 Coder 480B')).toBe(normalizeGroupKey('Qwen3-Coder 480B'));
    // …but a meaningful '+' is preserved, keeping distinct models apart.
    expect(normalizeGroupKey('Command R')).not.toBe(normalizeGroupKey('Command R+'));
  });
});

describe('groupRows', () => {
  it('collapses one model served by many providers into a single group', () => {
    const groups = groupRows(catalog(), NO_OVERRIDES);
    const gptoss = groups.find(g => g.groupKey === 'gpt oss 120b');
    expect(gptoss).toBeDefined();
    expect(gptoss!.members).toHaveLength(5);
    expect(gptoss!.groupLabel).toBe('GPT-OSS 120B'); // lowest intelligence_rank member
  });

  it('groups Llama 3.3 70B across differing model_ids but keeps fp8-fast separate', () => {
    const groups = groupRows(catalog(), NO_OVERRIDES);
    const llama = groups.find(g => g.groupKey === 'llama 3.3 70b');
    expect(llama!.members.map(m => m.model_db_id).sort()).toEqual([6, 7, 8]);
    // The fp8-fast variant normalizes to a DISTINCT key (merge only via override).
    expect(groups.find(g => g.groupKey === 'llama 3.3 70b fp8 fast')).toBeDefined();
  });

  it('merges a variant into a base group via an override', () => {
    const ov: UnifyOverrides = { merges: [{ into: 'Llama 3.3 70B', keys: ['llama 3.3 70b fp8 fast'] }], splits: [] };
    const groups = groupRows(catalog(), ov);
    const llama = groups.find(g => g.groupKey === 'llama 3.3 70b');
    expect(llama!.members.map(m => m.model_db_id).sort()).toEqual([6, 7, 8, 9]);
    expect(groups.find(g => g.groupKey === 'llama 3.3 70b fp8 fast')).toBeUndefined();
  });

  it('forces a member out of its group via a split override', () => {
    const ov: UnifyOverrides = { merges: [], splits: [{ member: 'groq:openai/gpt-oss-120b' }] };
    const groups = groupRows(catalog(), ov);
    const gptoss = groups.find(g => g.groupKey === 'gpt oss 120b');
    expect(gptoss!.members.map(m => m.model_db_id)).not.toContain(2);
    expect(groups.some(g => g.members.length === 1 && g.members[0].model_db_id === 2)).toBe(true);
  });

  it('merges names that differ only by separator punctuation (Qwen3 Coder vs Qwen3-Coder)', () => {
    const rows = [
      row(1, 'openrouter', 'qwen/qwen3-coder:free', 'Qwen3 Coder 480B'),
      row(2, 'ollama', 'qwen3-coder:480b', 'Qwen3-Coder 480B'),
    ];
    const groups = groupRows(rows, NO_OVERRIDES);
    expect(groups).toHaveLength(1);
    expect(groups[0].members.map(m => m.model_db_id).sort()).toEqual([1, 2]);
  });

  it('merges a free-tier name with its base model (DeepSeek V4 Flash Free → DeepSeek V4 Flash)', () => {
    const rows = [
      row(1, 'nvidia', 'deepseek-ai/deepseek-v4-flash', 'DeepSeek V4 Flash (NV)'),
      row(2, 'huggingface', 'deepseek-ai/DeepSeek-V4-Flash', 'DeepSeek V4 Flash (HF)'),
      row(3, 'opencode', 'deepseek-v4-flash-free', 'DeepSeek V4 Flash Free (OpenCode Zen)'),
    ];
    const groups = groupRows(rows, NO_OVERRIDES);
    expect(groups).toHaveLength(1);
    expect(groups[0].groupLabel).toBe('DeepSeek V4 Flash'); // "Free" dropped from the label
    expect(groups[0].members.map(m => m.model_db_id).sort()).toEqual([1, 2, 3]);
  });

  it('keeps models that differ by a meaningful char apart (Command R vs Command R+)', () => {
    const rows = [
      row(1, 'cohere', 'command-r-08-2024', 'Command R'),
      row(2, 'cohere', 'command-r-plus-08-2024', 'Command R+'),
    ];
    expect(groupRows(rows, NO_OVERRIDES)).toHaveLength(2);
  });

  it('does not merge newly discovered Kimi family variants through guessed labels', () => {
    const ids = ['kimi-k2-7-code', 'kimi-k2-instruct', 'kimi-k3', 'kimi-k3-fast', 'kimi-k3-instruct'];
    const rows = ids.map((modelId, index) => row(
      index + 1,
      'custom',
      modelId,
      niceDisplayName(modelId),
    ));
    const groups = groupRows(rows, NO_OVERRIDES);

    expect(groups).toHaveLength(ids.length);
    expect(groups.map(group => group.groupLabel).sort()).toEqual([
      'Kimi K2 Instruct',
      'Kimi 2.7 Coding',
      'Kimi K3',
      'Kimi K3 Fast',
      'Kimi K3 Instruct',
    ].sort());
  });

  it('repairs already-imported legacy Kimi labels during grouping without a DB write', () => {
    const rows = [
      row(1, 'custom', 'kimi-k3', 'Kimi K2.6'),
      row(2, 'custom', 'kimi-k3-instruct', 'Kimi K2.6'),
      row(3, 'custom', 'kimi-k2-7-code', 'Kimi K2.7'),
    ];
    const groups = groupRows(rows, NO_OVERRIDES);

    expect(groups).toHaveLength(3);
    expect(groups.map(group => group.groupLabel).sort()).toEqual([
      'Kimi 2.7 Coding',
      'Kimi K3',
      'Kimi K3 Instruct',
    ].sort());
    expect(rows.map(item => item.display_name)).toEqual(['Kimi K2.6', 'Kimi K2.6', 'Kimi K2.7']);
  });

  it('assigns deterministic, unique canonical ids (collisions get -2)', () => {
    const rows = [row(1, 'a', 'm1', 'Model X'), row(2, 'b', 'm2', 'Model X!')];
    const groups = groupRows(rows, NO_OVERRIDES);
    const ids = groups.map(g => g.canonicalId).sort();
    expect(ids).toEqual(['model-x', 'model-x-2']);
  });

  it('keeps identical custom models on different endpoints in separate groups', () => {
    const rows = [
      { ...row(1, 'custom', 'model-a', 'Model A'), endpoint_scope: 'http://one.example/v1' },
      { ...row(2, 'custom', 'model-a', 'Model A'), endpoint_scope: 'http://two.example/v1' },
      { ...row(3, 'custom', 'model-a-variant', 'Model A'), endpoint_scope: 'http://one.example/v1' },
    ];
    const groups = groupRows(rows, NO_OVERRIDES);
    expect(groups).toHaveLength(2);
    expect(groups.map(group => group.members.map(member => member.model_db_id).sort())).toEqual([
      [1, 3],
      [2],
    ]);
  });

  it('allows an explicit merge to cross custom endpoint scopes', () => {
    const rows = [
      { ...row(1, 'custom', 'model-a', 'Model A'), endpoint_scope: 'http://one.example/v1' },
      { ...row(2, 'custom', 'model-a', 'Model A'), endpoint_scope: 'http://two.example/v1' },
    ];
    const groups = groupRows(rows, {
      merges: [{ into: 'Model A', keys: ['custom:model-a'] }],
      splits: [],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].members.map(member => member.model_db_id).sort()).toEqual([1, 2]);
  });
});

describe('slugifyGroupLabel', () => {
  it('keeps digits and dots, hyphenates spaces', () => {
    expect(slugifyGroupLabel('Llama 3.3 70B')).toBe('llama-3.3-70b');
    expect(slugifyGroupLabel('GPT-OSS 120B')).toBe('gpt-oss-120b');
  });
});

describe('resolveRequestedIdToMembers', () => {
  const groups = groupRows(catalog(), NO_OVERRIDES);
  const gptoss = groups.find(g => g.groupKey === 'gpt oss 120b')!;

  it('resolves a canonical id to all member db ids', () => {
    expect(resolveRequestedIdToMembers(gptoss.canonicalId, groups)!.sort()).toEqual([1, 2, 3, 4, 5]);
  });
  it('resolves any member model_id (back-compat) to the whole group', () => {
    expect(resolveRequestedIdToMembers('gpt-oss-120b', groups)!.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(resolveRequestedIdToMembers('@cf/openai/gpt-oss-120b', groups)!.sort()).toEqual([1, 2, 3, 4, 5]);
  });
  it('resolves an explicit "platform:model_id" member', () => {
    expect(resolveRequestedIdToMembers('groq:openai/gpt-oss-120b', groups)!.sort()).toEqual([1, 2, 3, 4, 5]);
  });
  it('resolves case-insensitive, normalized, and provider-prefixed model alias requests', () => {
    // Case-insensitive canonicalId
    expect(resolveRequestedIdToMembers('GPT-OSS-120B', groups)!.sort()).toEqual([1, 2, 3, 4, 5]);
    // Case-insensitive model_id
    expect(resolveRequestedIdToMembers('LLAMA-3.3-70B-VERSATILE', groups)!.sort()).toEqual([6, 7, 8]);
    // Provider prefixed request stripped matching
    expect(resolveRequestedIdToMembers('groq/llama-3.3-70b-versatile', groups)!.sort()).toEqual([6, 7, 8]);
    // Normalized separator matching
    expect(resolveRequestedIdToMembers('gpt oss 120b', groups)!.sort()).toEqual([1, 2, 3, 4, 5]);
  });
  it('returns null for an unknown id', () => {
    expect(resolveRequestedIdToMembers('does-not-exist', groups)).toBeNull();
  });
});
