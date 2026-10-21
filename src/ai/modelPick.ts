// Picks a model for each job from whatever the user's AI provider offers.
// Pure: no vscode imports, so it can be unit tested.

export type Slot = 'deep' | 'standard' | 'fast';

export const SLOTS: Slot[] = ['deep', 'standard', 'fast'];

export const SLOT_LABELS: Record<Slot, string> = {
  deep: 'Deep: building the map and walkthroughs',
  standard: 'Standard: lessons and explanations',
  fast: 'Fast: quick explanations on demand',
};

export interface ModelInfo {
  id: string;
  name: string;
  family: string;
  vendor: string;
  maxInputTokens: number;
}

// Ordered preferences per slot. Names change often, so these are loose patterns;
// anything unmatched falls back to a sensible default below.
const PREFERENCES: Record<Slot, RegExp[]> = {
  deep: [/opus/i, /gpt-5(?!.*\b(mini|nano)\b)/i, /\bsol\b/i, /gemini.*pro/i, /sonnet/i, /\bo\d\b(?!.*mini)/i],
  standard: [/sonnet/i, /gpt-5(?!.*\bnano\b)/i, /\bsol\b/i, /gpt-4\.1/i, /gemini.*pro/i, /opus/i],
  // GPT Luna is OpenAI's cheaper line.
  fast: [/haiku/i, /\bluna\b/i, /\b(mini|flash|nano)\b/i, /gpt-4o/i, /sonnet/i],
};

function label(m: ModelInfo): string {
  return `${m.name} ${m.family} ${m.id}`;
}

/** Highest version number found in the name, e.g. "Claude Opus 5.5" -> 5.5. */
export function versionOf(m: ModelInfo): number {
  const nums = label(m).match(/\d+(?:\.\d+)?/g);
  if (!nums) return 0;
  return Math.max(...nums.map(Number).filter((n) => n < 100));
}

/**
 * `setting` is the user's choice for this slot: "auto", or a model id, family or name fragment.
 */
export function pickModel(models: ModelInfo[], slot: Slot, setting = 'auto'): ModelInfo | undefined {
  if (models.length === 0) return undefined;

  const wanted = setting.trim();
  if (wanted && wanted !== 'auto') {
    const lower = wanted.toLowerCase();
    const exact = models.find((m) => m.id === wanted) ?? models.find((m) => m.family === wanted);
    if (exact) return exact;
    const partial = models.find((m) => label(m).toLowerCase().includes(lower));
    if (partial) return partial;
    // The chosen model is no longer offered; fall through to auto.
  }

  for (const pattern of PREFERENCES[slot]) {
    const candidates = models.filter((m) => pattern.test(label(m)));
    if (candidates.length > 0) {
      return [...candidates].sort((a, b) => versionOf(b) - versionOf(a))[0];
    }
  }

  if (slot === 'deep') {
    return [...models].sort((a, b) => b.maxInputTokens - a.maxInputTokens)[0];
  }
  return models[0];
}
