/**
 * Calibrate size_label + intelligence_rank from model name.
 *
 * FreeLLMAPI scoring:
 *   intelligenceComposite = tierValue(size_label)*1000 - intelligence_rank
 *   (lower rank = smarter within tier; Frontier > Large > Medium > Small)
 *
 * Philosophy (operator preference):
 *   - True flagships (GPT-5.5 / frontier agent) → Frontier, top ranks
 *   - DeepSeek-V4-Flash etc. → Large / ~passing band (~60 when mixed with Frontier)
 *   - Mid 30–80B → Medium
 *   - Lite / 1–14B → Small
 * Do NOT mark everything Frontier/100.
 */

export type SizeLabel = 'Frontier' | 'Large' | 'Medium' | 'Small';

export interface ModelMeta {
  sizeLabel: SizeLabel;
  /** Lower = smarter within size_label tier. */
  intelligenceRank: number;
  /** Rough absolute skill 0–100 for docs / scripts (not stored unless needed). */
  skillHint: number;
}

export function calibrateModelMeta(modelId: string, displayName?: string): ModelMeta {
  const s = `${modelId} ${displayName ?? ''}`.toLowerCase().replace(/[[\]]/g, '');

  // Non-chat / junk → Small + bad rank
  if (/embed|embedding|rerank|tts|whisper|audio|speech|safety|safeguard|guard|moderat/.test(s)) {
    return { sizeLabel: 'Small', intelligenceRank: 90, skillHint: 10 };
  }

  // ── Absolute top (≈90–100 skill) ─────────────────────────────────────────
  if (/gpt-5\.5|gpt-5-pro|claude-4|claude-opus|o3-pro|fable|mythos|sonnet-4|opus-4/.test(s)) {
    return { sizeLabel: 'Frontier', intelligenceRank: 1, skillHint: 98 };
  }
  if (/gpt-5(?!.*(?:nano|mini|chat))|claude-3\.7|claude-sonnet-4|gemini-3\.1-pro|gemini-3-pro/.test(s)) {
    return { sizeLabel: 'Frontier', intelligenceRank: 2, skillHint: 95 };
  }

  // ── Strong frontier open/agent (≈80–92) ──────────────────────────────────
  if (/kimi|moonshot|k2\.6|k2\.7|k2-6|k2-7/.test(s)) {
    return { sizeLabel: 'Frontier', intelligenceRank: 4, skillHint: 90 };
  }
  if (/deepseek-v4-pro|deepseek\/deepseek-v4-pro/.test(s)) {
    return { sizeLabel: 'Frontier', intelligenceRank: 5, skillHint: 88 };
  }
  if (/minimax|m2\.7|m2-7|m3(?!\d)/.test(s) && /minimax|m2|m3/.test(s)) {
    return { sizeLabel: 'Frontier', intelligenceRank: 6, skillHint: 87 };
  }
  if (/mistral-large|675b|hermes.*405|405b/.test(s)) {
    return { sizeLabel: 'Frontier', intelligenceRank: 6, skillHint: 87 };
  }
  if (/nemotron-3-ultra|ultra-550/.test(s)) {
    return { sizeLabel: 'Frontier', intelligenceRank: 7, skillHint: 86 };
  }
  if (/qwen3\.5-397|397b|qwen3\.5-122|122b-a10b/.test(s)) {
    return { sizeLabel: 'Frontier', intelligenceRank: 8, skillHint: 85 };
  }
  if (/gemini-3\.5(?!.*lite)|gemini-3-flash-preview/.test(s)) {
    return { sizeLabel: 'Frontier', intelligenceRank: 8, skillHint: 84 };
  }
  if (/command-a-reasoning|command_a_reasoning/.test(s)) {
    return { sizeLabel: 'Frontier', intelligenceRank: 10, skillHint: 82 };
  }
  if (/glm-5|z-ai\/glm-5|ling-2\.6-1t|1t-instruct/.test(s)) {
    return { sizeLabel: 'Frontier', intelligenceRank: 10, skillHint: 82 };
  }

  // ── Large / solid (≈55–75) — V4-Flash ~60 “passing” ─────────────────────
  if (/deepseek-v4-flash|deepseek-v4(?!-pro)/.test(s) || /deepseek-v4/.test(s)) {
    return { sizeLabel: 'Large', intelligenceRank: 12, skillHint: 60 };
  }
  if (/qwen3-coder|coder-next|coder-480|codestral|devstral|kat-coder|mistral-code/.test(s)) {
    return { sizeLabel: 'Large', intelligenceRank: 14, skillHint: 68 };
  }
  if (/gpt-oss-120|oss-120/.test(s)) {
    return { sizeLabel: 'Large', intelligenceRank: 15, skillHint: 65 };
  }
  if (/nemotron-3-super|super-120|nemotron-3-120/.test(s)) {
    return { sizeLabel: 'Large', intelligenceRank: 16, skillHint: 64 };
  }
  if (/gemma-4-31|gemma4:31|gpt-4\.1(?!.*(?:mini|nano))|gpt-4o(?!.*mini)/.test(s)) {
    return { sizeLabel: 'Large', intelligenceRank: 16, skillHint: 66 };
  }
  if (/big-pickle|llama-4-maverick|magistral-medium/.test(s)) {
    return { sizeLabel: 'Large', intelligenceRank: 18, skillHint: 62 };
  }
  if (/gemini-3(?!.*lite)|gemini-2\.5-pro/.test(s)) {
    return { sizeLabel: 'Large', intelligenceRank: 18, skillHint: 63 };
  }

  // ── Medium (≈40–55) ─────────────────────────────────────────────────────
  if (/(?:^|[^0-9])(70|72|80|120)b(?:[^0-9]|$)/.test(s) || /llama-3\.3|llama-3\.1-70|qwen3-next|qwen3\.5-35|qwen3\.6|35b|49b/.test(s)) {
    return { sizeLabel: 'Medium', intelligenceRank: 25, skillHint: 50 };
  }
  if (/glm-4\.7|glm-4\.6|mistral-medium|mistral-small|ministral-14|gpt-oss-20|compound|command-r|mimo|laguna-m|gemma-4-26|nano-30|nemotron-3-nano|seed-oss/.test(s)) {
    return { sizeLabel: 'Medium', intelligenceRank: 30, skillHint: 48 };
  }
  if (/(?:^|[^0-9])(20|24|26|27|30|32|36)b(?:[^0-9]|$)/.test(s)) {
    return { sizeLabel: 'Medium', intelligenceRank: 32, skillHint: 45 };
  }
  // ── Small / lite (≈15–35) — check before generic llama-3 mid ────────────
  if (/flash-lite|-lite|instant|nano-9|lfm|liquid|granite.*micro|tiny|ministral-3|ministral-8|laguna-xs|1\.2b/.test(s)
    || /(?:^|[^0-9])([1-9]|1[0-4])b(?:[^0-9]|$)/.test(s)
    || /step-3\.[57]-flash|mercury|stepfun\/step/.test(s)) {
    return { sizeLabel: 'Small', intelligenceRank: 50, skillHint: 28 };
  }

  if (/llama-3|llama3|llama-4-scout|scout|gemini-2\.5-flash(?!-lite)|deepseek-r1|distill|magistral-small/.test(s)) {
    return { sizeLabel: 'Medium', intelligenceRank: 35, skillHint: 45 };
  }

  // Default unknown mid-tier — NOT Frontier, NOT 100
  return { sizeLabel: 'Medium', intelligenceRank: 40, skillHint: 42 };
}

/** Prefer a human groupable display name for unify (match catalog labels). */
export function niceDisplayName(modelId: string, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  const id = modelId.trim();
  const base = id.split('/').pop() || id;
  if (/k2\.6|k2-6|kimi-k2\.6/i.test(id)) return 'Kimi K2.6';
  if (/k2\.7|k2-7|kimi-k2\.7/i.test(id)) return 'Kimi K2.7';
  if (/kimi|moonshot/i.test(id)) return 'Kimi K2.6';
  if (/deepseek-v4-flash/i.test(id)) return 'DeepSeek V4 Flash';
  if (/deepseek-v4-pro/i.test(id)) return 'DeepSeek V4 Pro';
  if (/mistral-large/i.test(id)) return 'Mistral Large';
  if (/minimax.*m2\.7|m2\.7/i.test(id)) return 'MiniMax M2.7';
  if (/minimax/i.test(id)) return 'MiniMax';
  if (/gpt-oss-120/i.test(id)) return 'GPT-OSS 120B';
  if (/nemotron-3-ultra/i.test(id)) return 'Nemotron 3 Ultra 550B';
  return base
    .replace(/[:_]+/g, '-')
    .split('-')
    .filter(Boolean)
    .map(w => (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}
