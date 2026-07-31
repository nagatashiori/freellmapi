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
  const normalizedBase = base.toLowerCase().replace(/_/g, '-');
  const canonicalBase = normalizedBase.replace(/:free$/, '').replace(/-free$/, '');
  // Only map exact canonical aliases. A broad `kimi` match incorrectly labels
  // newer families such as kimi-k3 and variants such as kimi-k2-instruct as
  // Kimi K2.6, which then makes model-groups merge unrelated models.
  if (/^kimi-for-coding$/.test(canonicalBase) || /^(?:kimi-)?k2[.-]7-(?:code|coding)$/.test(canonicalBase)) {
    return 'Kimi 2.7 Coding';
  }
  if (/^(?:kimi-)?k2[.-]6$/.test(canonicalBase)) return 'Kimi K2.6';
  if (/^(?:kimi-)?k2[.-]7$/.test(canonicalBase)) return 'Kimi K2.7';
  if (/deepseek-v4-flash/i.test(id)) return 'DeepSeek V4 Flash';
  if (/deepseek-v4-pro/i.test(id)) return 'DeepSeek V4 Pro';
  if (/mistral-large/i.test(id)) return 'Mistral Large';
  const miniMaxMatch = /^minimax-?m?(\d+(?:\.\d+)?)(?:-(.+))?$/.exec(canonicalBase);
  if (miniMaxMatch) {
    const [, version, suffix] = miniMaxMatch;
    const suffixLabel = suffix
      ? ` ${suffix.split('-').map(token => token[0].toUpperCase() + token.slice(1)).join(' ')}`
      : '';
    return `MiniMax M${version}${suffixLabel}`;
  }
  if (/minimax/i.test(id)) return 'MiniMax';
  if (/gpt-oss-120/i.test(id)) return 'GPT-OSS 120B';
  if (/^nemotron-3-super(?:-|$)/.test(canonicalBase)) return 'Nemotron 3 Super';
  if (/nemotron-3-ultra/i.test(id)) return 'Nemotron 3 Ultra 550B';
  const glmMatch = /^glm-(\d+(?:\.\d+)?[a-z]*)(?:-([a-z]+(?:-[a-z]+)*))?$/.exec(canonicalBase);
  if (glmMatch) {
    const [, version, variant] = glmMatch;
    const versionLabel = version.replace(/[a-z]/g, ch => ch.toUpperCase());
    const variantLabel = variant
      ? ` ${variant.split('-').map(t => t[0].toUpperCase() + t.slice(1)).join(' ')}`
      : '';
    return `GLM ${versionLabel}${variantLabel}`;
  }
  const llama32 = /^llama-3\.2-(\d+)b/.exec(canonicalBase);
  if (llama32) {
    return `Llama 3.2 ${llama32[1]}B${/-vision/.test(canonicalBase) ? ' Vision' : ''}`;
  }
  if (/^hunyuanocr$/i.test(canonicalBase)) return 'Hunyuan OCR';
  if (/^hunyuan-?mt-?7b$/i.test(canonicalBase)) return 'Hunyuan MT 7B';

  // Keep numeric version separators such as `4-1` and `k2-7` intact. They are
  // part of the model identity; turning every hyphen into a space makes
  // Claude Opus 4-1 look like an unrelated or ambiguous label.
  const tokens = base.replace(/[:_]+/g, '-').split('-').filter(Boolean);
  const words: string[] = [];
  for (const token of tokens) {
    const previous = words[words.length - 1];
    if (/^\d+$/.test(token) && previous && /\d$/.test(previous)) {
      words[words.length - 1] = `${previous}-${token}`;
      continue;
    }
    words.push(/^[a-z]/.test(token) ? token[0].toUpperCase() + token.slice(1) : token);
  }
  return words.join(' ');
}

/**
 * Repair labels generated by older versions without overwriting operator names.
 * This is read-only compatibility logic: it fixes grouping/listing at runtime
 * while leaving the models table, enable flags, and priorities untouched.
 */
export function repairLegacyDisplayName(modelId: string, storedDisplayName?: string): string {
  const stored = storedDisplayName?.trim() ?? '';
  if (!stored) return niceDisplayName(modelId);

  const base = modelId.trim().split('/').pop() || modelId.trim();
  // Provider/variant parentheticals such as "(CF)", "(NV)", "(HF)" and the
  // trailing "free" pricing tier are cosmetic suffixes added by catalog sync.
  // They must not prevent us from recognizing an otherwise auto-generated old
  // label. Strip them before comparing with the legacy auto-label.
  const stripCosmeticSuffixes = (value: string) => {
    let s = value.trim();
    let prev: string;
    do {
      prev = s;
      s = s.replace(/\s*\([^()]*\)\s*$/, '').trim();
      s = s.replace(/\s+free$/i, '').trim();
    } while (s !== prev);
    return s;
  };

  const legacyTokens = base
    .replace(/[:_]+/g, '-')
    .split('-')
    .filter(Boolean)
    .map(token => (/^[a-z]/.test(token) ? token[0].toUpperCase() + token.slice(1) : token))
    .join(' ');
  const current = niceDisplayName(modelId);
  const normalizeAutoLabel = (value: string) => value
    .toLowerCase()
    .replace(/[-_:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+free$/, '')
    .trim();
  const strippedStored = stripCosmeticSuffixes(stored);
  if (normalizeAutoLabel(strippedStored) === normalizeAutoLabel(legacyTokens) && stored !== current) return current;

  const normalizedBase = base.toLowerCase().replace(/_/g, '-').replace(/:free$/, '');
  if (/^minimax[-]?m?\d+(?:\.\d+)?(?:-|$)/.test(normalizedBase)
    && (/^minimax$/i.test(stored) || /^minimax m2\.7$/i.test(stored))) {
    return current;
  }
  // Old catalog imports persisted labels such as "Kimi K2.7", "Kimi K2.7 Code",
  // or "Kimi K2.7 Code (CF)" for models whose canonical identity is the
  // Kimi 2.7 Coding family. Normalize them so the group does not split.
  if (/^(?:kimi-for-coding|kimi-k2[.-]7-(?:code|coding))(?::free)?$/i.test(base)) {
    return current;
  }

  // Older code used these two labels for every non-canonical Kimi/Moonshot id.
  // Keep exact K2.6/K2.7 aliases intact, but repair variants such as K2-instruct
  // and K3 that were already imported before the fix.
  const exactKimiAlias = /^(?:kimi-)?k2[.-][67]$/.test(normalizedBase);
  if ((stored === 'Kimi K2.6' || stored === 'Kimi K2.7')
    && /kimi|moonshot/i.test(modelId)
    && !exactKimiAlias) {
    return current;
  }

  // catalog sync once persisted "Claude Opus 4.8" on every claude-opus-4-N id.
  // Follow the id's own version (canonical "4-6"/"4-7"/"4-8") so they stop
  // collapsing into one 4.8 group.
  const opusVersion = /^claude-opus-4-(\d+)$/.exec(base);
  if (opusVersion && /^claude opus 4\.8$/i.test(stored)) {
    return current;
  }

  // voapi aliases for Sonnet 4 (claude-sonnet-4-*) were labeled "Claude Sonnet
  // 4.5" by the old broad rules; keep genuine 4.5 ids but split the 4 ones out.
  if (/^claude-sonnet-4-(?!5)/.test(base) && /^claude sonnet 4\.5$/i.test(stored)) {
    return current;
  }

  // GLM vision ids (glm-4.6v, GLM-4.6-V, GLM-4.6V-Flash) were imported under
  // the plain "GLM-4.6" text label; give them their own version label.
  if (/4\.6[-_]?v/i.test(modelId) && /^glm[- .]?4\.6$/i.test(stored)) {
    return current;
  }

  // GLM flash is a distinct model from the base version (4.7 Flash ≠ 4.7).
  // catalog sync imported glm-4.7-flash rows under the plain "GLM-4.7" label.
  const glmFlashBase = base.replace(/:free$/i, '');
  if (/^glm-\d+(?:\.\d+)?[a-z]*-flash$/i.test(glmFlashBase) && /^glm[- .]?\d+(?:\.\d+)?$/i.test(stored)) {
    return current;
  }

  // GPT / o1 / o3 family spec suffixes (mini/nano/pro/preview) that a stored
  // family label omitted: gpt-5-3-mini stored as "GPT-5.3", o1-mini stored as
  // "o1", o3-pro stored as "o3". Follow the id so spec variants stop collapsing
  // into the base version group.
  const baseSpec = /-?(?:mini|nano|pro|preview)(?:-|$)/i;
  if (/^(?:o1|o3|gpt-5)/i.test(base) && baseSpec.test(base) && !baseSpec.test(stored)) {
    return current;
  }

  // Llama 3.2 rows were all imported under one "Llama 3.2" label; the size is
  // part of the model identity (1b/3b/11b are distinct checkpoints).
  const llama32 = /^llama-3\.2-(\d+)b/.exec(base);
  if (llama32 && /^llama 3\.2$/i.test(stored)) {
    return current;
  }

  // Hunyuan OCR / MT-7B were labeled "Hunyuan Hy3" by an old override.
  if (/hunyuan-?mt-?7b|hunyuanocr/i.test(modelId) && /^hunyuan hy3$/i.test(stored)) {
    return current;
  }

  // Qwen2.5-Coder-32B was folded into the Qwen3 Coder group by an old override.
  if (/qwen2?\.?5-coder-32b/i.test(modelId) && /^qwen3 coder$/i.test(stored)) {
    return current;
  }

  // Mistral Large 2 checkpoint ids (2407 / 2-instruct / 2411 / pixtral-2411)
  // were imported under the same "Mistral Large" label as Large 3; keep the
  // generations apart.
  if ((/^mistral-large-(?:2-instruct|2411|pixtral-2411)$/i.test(base) || /mistral-large-instruct-2407/i.test(modelId))
    && /^mistral large( 3)?$/i.test(stored)) {
    return 'Mistral Large 2';
  }

  return stored;
}
