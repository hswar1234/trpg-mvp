const FALLBACK_LLM_MODELS = ['gpt-5.4', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini'] as const;

export const ALLOWED_LLM_MODELS: string[] = resolveAllowedModels();
export const DEFAULT_LLM_MODEL = resolveDefaultModel();

function resolveAllowedModels(): string[] {
  const raw = process.env.NEXT_PUBLIC_ALLOWED_LLM_MODELS?.trim();
  if (!raw) return [...FALLBACK_LLM_MODELS];

  const parsed = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (parsed.length === 0) return [...FALLBACK_LLM_MODELS];
  return Array.from(new Set(parsed));
}

function resolveDefaultModel(): string {
  const configured = process.env.NEXT_PUBLIC_DEFAULT_MODEL?.trim();
  if (configured && ALLOWED_LLM_MODELS.includes(configured)) return configured;
  return ALLOWED_LLM_MODELS[0] ?? FALLBACK_LLM_MODELS[0];
}
