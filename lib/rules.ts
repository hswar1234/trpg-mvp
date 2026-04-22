import type { Ability, CharacterStats, ResolutionResult, RollMode } from './types.ts';

export interface RuleConfig {
  baseDice: 'd20';
  partialWindow: number;
  minDc: number;
  maxDc: number;
  rollMode: RollMode;
}

export const DEFAULT_RULE_CONFIG: RuleConfig = {
  baseDice: 'd20',
  partialWindow: 1,
  minDc: 5,
  maxDc: 20,
  rollMode: 'manual_input',
};

export interface ResolveInput {
  stat: Ability;
  skill: string | null;
  dc: number;
  diceResult: number;
  stats: CharacterStats;
  skills: Record<string, number>;
  config?: Partial<RuleConfig>;
}

export interface ResolveOutput {
  result: ResolutionResult;
  finalValue: number;
  statModifier: number;
  skillBonus: number;
  dc: number;
}

export function getStatModifier(statValue: number): number {
  return Math.floor((statValue - 10) / 2);
}

export function validateDiceResult(dice: string, value: number): boolean {
  if (!Number.isInteger(value)) return false;
  if (dice === 'd20') return value >= 1 && value <= 20;
  return false;
}

export function resolveCheck(input: ResolveInput): ResolveOutput {
  const config = { ...DEFAULT_RULE_CONFIG, ...input.config };
  const normalizedDc = clamp(input.dc, config.minDc, config.maxDc);
  const statModifier = getStatModifier(input.stats[input.stat]);
  const skillBonus = input.skill ? input.skills[input.skill] ?? 0 : 0;
  const finalValue = input.diceResult + statModifier + skillBonus;

  const lowerPartial = normalizedDc - config.partialWindow;
  const upperPartial = normalizedDc + config.partialWindow;

  let result: ResolutionResult;
  if (finalValue < lowerPartial) {
    result = 'failed';
  } else if (finalValue <= upperPartial) {
    result = 'partial';
  } else {
    result = 'success';
  }

  return {
    result,
    finalValue,
    statModifier,
    skillBonus,
    dc: normalizedDc,
  };
}

export function clampDc(dc: number, config: Partial<RuleConfig> = {}): number {
  const merged = { ...DEFAULT_RULE_CONFIG, ...config };
  return clamp(dc, merged.minDc, merged.maxDc);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
