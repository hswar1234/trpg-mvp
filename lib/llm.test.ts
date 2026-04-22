import { beforeEach, describe, expect, it, vi } from 'vitest';

type LlmModule = typeof import('./llm.ts');

describe('llm required behavior', () => {
  let llm: LlmModule;

  beforeEach(async () => {
    vi.resetModules();
    delete process.env.OPENAI_API_KEY;
    llm = await import('./llm.ts');
  });

  it('throws when server API key is missing for scene generation', async () => {
    await expect(
      llm.generateScene(
        {
          scenarioTheme: '금지된 성당의 그림자',
          currentTurn: 1,
          actions: [],
          results: [],
        },
        'gpt-5.4'
      )
    ).rejects.toThrow('OPENAI_API_KEY');
  });

  it('throws when server API key is missing for action planning', async () => {
    await expect(
      llm.planActionChecks(
        {
          scenarioTheme: '고성 폐허',
          currentScene: '어두운 복도',
          ruleset: 'd20-basic',
          actions: [
            {
              playerId: 'p1',
              playerName: 'A',
              actionText: '주변을 조사한다',
              characterStats: {
                strength: 10,
                dexterity: 10,
                intelligence: 12,
                charisma: 10,
                constitution: 10,
                wisdom: 11,
              },
              skills: { investigation: 1 },
            },
          ],
        },
        'gpt-5.4'
      )
    ).rejects.toThrow('OPENAI_API_KEY');
  });
});
