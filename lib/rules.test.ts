import { describe, expect, it } from 'vitest';
import { getStatModifier, resolveCheck, validateDiceResult } from './rules.ts';
import type { CharacterStats } from './types.ts';

const baseStats: CharacterStats = {
  strength: 16,
  dexterity: 14,
  intelligence: 12,
  charisma: 10,
  constitution: 8,
  wisdom: 13,
};

describe('rules', () => {
  it('calculates ability modifier from stat', () => {
    expect(getStatModifier(16)).toBe(3);
    expect(getStatModifier(10)).toBe(0);
    expect(getStatModifier(8)).toBe(-1);
  });

  it('validates d20 ranges', () => {
    expect(validateDiceResult('d20', 1)).toBe(true);
    expect(validateDiceResult('d20', 20)).toBe(true);
    expect(validateDiceResult('d20', 0)).toBe(false);
    expect(validateDiceResult('d20', 21)).toBe(false);
    expect(validateDiceResult('d20', 7.5)).toBe(false);
  });

  it('resolves failed / partial / success bands using default window', () => {
    const failed = resolveCheck({
      stat: 'dexterity',
      skill: 'stealth',
      dc: 15,
      diceResult: 7,
      stats: baseStats,
      skills: { stealth: 1 },
    });
    const partial = resolveCheck({
      stat: 'dexterity',
      skill: 'stealth',
      dc: 15,
      diceResult: 11,
      stats: baseStats,
      skills: { stealth: 1 },
    });
    const success = resolveCheck({
      stat: 'dexterity',
      skill: 'stealth',
      dc: 15,
      diceResult: 14,
      stats: baseStats,
      skills: { stealth: 1 },
    });

    expect(failed.result).toBe('failed');
    expect(partial.result).toBe('partial');
    expect(success.result).toBe('success');
    expect(success.finalValue).toBe(17);
  });

  it('supports configurable partial window', () => {
    const result = resolveCheck({
      stat: 'wisdom',
      skill: null,
      dc: 12,
      diceResult: 9,
      stats: baseStats,
      skills: {},
      config: { partialWindow: 0 },
    });

    expect(result.finalValue).toBe(10);
    expect(result.result).toBe('failed');
  });
});
