import OpenAI from 'openai';
import { z } from 'zod';
import { ABILITIES } from './types.ts';
import type {
  ActionPlanningInput,
  ActionPlanningOutput,
  SceneGenerationInput,
  ScenePayload,
} from './types.ts';
import { clampDc } from './rules.ts';

const ENTITY_TYPES = ['object', 'npc', 'enemy', 'location'] as const;
const ABILITY_SET = new Set<string>(ABILITIES);

const sceneSchema = z.object({
  summary: z.string().min(1),
  sceneDescription: z.string().min(1),
  choicesHint: z.array(z.string()).default([]),
  importantEntities: z
    .array(
      z.object({
        name: z.string(),
        type: z.enum(ENTITY_TYPES),
      })
    )
    .default([]),
  requiresChecks: z.array(z.unknown()).optional(),
});

const actionPlanSchema = z.object({
  resolutions: z.array(
    z.object({
      playerId: z.string(),
      actionText: z.string(),
      checkRequired: z.boolean().default(true),
      checkType: z.enum(ABILITIES).default('wisdom'),
      skill: z.string().nullable().optional(),
      dice: z.literal('d20').default('d20'),
      dc: z.number().int().min(5).max(20),
      reason: z.string().min(1),
      preRollNarrative: z.string().min(1),
      successOutcome: z.string().min(1),
      partialOutcome: z.string().min(1),
      failureOutcome: z.string().min(1),
    })
  ),
});

const MODEL_FALLBACK_CHAIN = ['gpt-5.4', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini'];
const STRUCTURED_OUTPUT_RETRY_LIMIT = 2;

export async function generateScene(input: SceneGenerationInput, model: string): Promise<ScenePayload> {
  const client = requireOpenAIClient();

  const prompt = [
    '당신은 온라인 TRPG의 GM입니다.',
    '반드시 JSON만 응답하세요.',
    'sceneDescription은 현재 턴의 핵심 상황만 2~4문장으로 작성하세요.',
    '이전 턴 요약/회고를 길게 반복하지 마세요.',
    '',
    `시나리오: ${input.scenarioTheme}`,
    `현재 턴: ${input.currentTurn}`,
    `이전 장면: ${input.lastSceneDescription ?? '없음'}`,
    '',
    '플레이어 행동:',
    input.actions.length === 0
      ? '- 없음 (초기 장면 생성)'
      : input.actions.map((action) => `- ${action.playerName}: ${action.actionText}`).join('\n'),
    '',
    '판정 결과:',
    input.results.length === 0
      ? '- 없음'
      : input.results
          .map((result) => `- ${result.playerName} / ${result.actionText} / ${result.result}`)
          .join('\n'),
    '',
    '응답 스키마:',
    JSON.stringify(
      {
        summary: '한 문장 요약',
        sceneDescription: '2~4문장 현재 핵심 상황',
        choicesHint: ['다음 행동 힌트 1', '다음 행동 힌트 2', '다음 행동 힌트 3'],
        importantEntities: [{ name: '핵심 대상', type: 'object' }],
        requiresChecks: [],
      },
      null,
      2
    ),
  ].join('\n');

  try {
    const parsed = await requestStructuredJson({
      label: 'LLM scene',
      client,
      requestedModel: model,
      temperature: 0.45,
      schema: sceneSchema,
      coerceObject: coerceSceneObject,
      salvageFromText: salvageSceneFromRawText,
      messages: [
        {
          role: 'system',
          content: '당신은 구조화된 JSON으로만 응답하는 TRPG 진행자입니다.',
        },
        { role: 'user', content: prompt },
      ],
    });

    return {
      summary: parsed.summary,
      sceneDescription: parsed.sceneDescription,
      choicesHint: parsed.choicesHint.slice(0, 5),
      importantEntities: parsed.importantEntities.slice(0, 8),
    };
  } catch (error) {
    throw toUserFacingLlmError('scene', error);
  }
}

export async function planActionChecks(input: ActionPlanningInput, model: string): Promise<ActionPlanningOutput> {
  const client = requireOpenAIClient();

  const prompt = [
    '당신은 TRPG 판정 설계 보조자입니다.',
    '최종 판정 계산은 서버가 담당하므로, 필요한 체크만 JSON으로 제안하세요.',
    '응답은 반드시 JSON 하나여야 하며 모든 resolution 필드를 채우세요.',
    '',
    `시나리오: ${input.scenarioTheme}`,
    `현재 장면: ${input.currentScene}`,
    `룰셋: ${input.ruleset}`,
    '',
    '행동 목록:',
    input.actions
      .map((action) => {
        const statLine = Object.entries(action.characterStats)
          .map(([name, value]) => `${name}:${value}`)
          .join(', ');
        return `- playerId:${action.playerId}, playerName:${action.playerName}, action:${action.actionText}, stats:[${statLine}]`;
      })
      .join('\n'),
    '',
    '규칙:',
    '- 능력치: strength, dexterity, intelligence, charisma, constitution, wisdom',
    '- dice는 d20 고정',
    '- dc는 5~20 정수',
    '- checkRequired가 false일 수도 있음',
    '- 각 resolution에는 preRollNarrative/successOutcome/partialOutcome/failureOutcome을 반드시 채울 것',
    '',
    '응답 스키마:',
    JSON.stringify(
      {
        resolutions: [
          {
            playerId: 'p1',
            actionText: '문을 발로 찬다',
            checkRequired: true,
            checkType: 'strength',
            skill: null,
            dice: 'd20',
            dc: 12,
            reason: '무거운 문을 힘으로 밀어야 함',
            preRollNarrative: '행동 직전 상황',
            successOutcome: '성공 시 서사',
            partialOutcome: '부분 성공 시 서사',
            failureOutcome: '실패 시 서사',
          },
        ],
      },
      null,
      2
    ),
  ].join('\n');

  try {
    const parsed = await requestStructuredJson({
      label: 'LLM action-plan',
      client,
      requestedModel: model,
      temperature: 0.2,
      schema: actionPlanSchema,
      coerceObject: coerceActionPlanObject,
      messages: [
        {
          role: 'system',
          content: '당신은 JSON만 출력하는 TRPG 판정 계획 모델입니다.',
        },
        { role: 'user', content: prompt },
      ],
    });

    const normalized = parsed.resolutions.map((resolution) => ({
      ...resolution,
      dc: clampDc(resolution.dc),
      skill: resolution.skill ?? null,
      preRollNarrative: resolution.preRollNarrative.trim(),
      successOutcome: resolution.successOutcome.trim(),
      partialOutcome: resolution.partialOutcome.trim(),
      failureOutcome: resolution.failureOutcome.trim(),
    }));

    return { resolutions: normalized };
  } catch (error) {
    throw toUserFacingLlmError('check-plan', error);
  }
}

function requireOpenAIClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY가 서버에 설정되지 않았습니다. .env를 확인하고 서버를 재시작해 주세요.');
  }
  return new OpenAI({ apiKey });
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') {
          return item.text;
        }
        return '';
      })
      .join('\n');
  }
  return '';
}

function parseJsonWithSchema<T>(raw: string, schema: z.ZodType<T>): T | null {
  if (!raw) return null;

  const trimmed = raw.trim();
  const candidates = [trimmed, extractJsonBlock(trimmed)].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      const parsed = parsePossiblyNestedJson(candidate);
      const direct = schema.safeParse(parsed);
      if (direct.success) {
        return direct.data;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function parsePossiblyNestedJson(raw: string): unknown {
  const first = JSON.parse(raw) as unknown;
  if (typeof first === 'string') {
    return JSON.parse(first);
  }
  return first;
}

function extractJsonBlock(text: string): string {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || firstBrace >= lastBrace) return text;
  return text.slice(firstBrace, lastBrace + 1);
}

async function createCompletionWithFallbackModel(input: {
  client: OpenAI;
  requestedModel: string;
  temperature: number;
  responseFormat?: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming['response_format'];
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
}) {
  const candidates = Array.from(new Set([input.requestedModel, ...MODEL_FALLBACK_CHAIN]));
  let lastError: unknown = null;

  for (const candidate of candidates) {
    try {
      return await input.client.chat.completions.create({
        model: candidate,
        temperature: input.temperature,
        response_format: input.responseFormat,
        messages: input.messages,
      });
    } catch (error) {
      lastError = error;
      console.warn(`LLM request failed with model "${candidate}". Trying next fallback model.`);
    }
  }

  throw lastError ?? new Error('All LLM model attempts failed.');
}

async function requestStructuredJson<T>(input: {
  label: string;
  client: OpenAI;
  requestedModel: string;
  temperature: number;
  schema: z.ZodType<T>;
  coerceObject?: (value: unknown) => unknown;
  salvageFromText?: (text: string) => unknown | null;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
}): Promise<T> {
  let lastRaw = '';

  for (let attempt = 0; attempt <= STRUCTURED_OUTPUT_RETRY_LIMIT; attempt += 1) {
    const messages =
      attempt === 0
        ? input.messages
        : [
            ...input.messages,
            {
              role: 'user' as const,
              content:
                '이전 응답은 JSON 스키마를 만족하지 못했습니다. 마크다운/설명 없이 JSON 객체 하나만 다시 출력하세요.',
            },
          ];

    const response = await createCompletionWithFallbackModel({
      client: input.client,
      requestedModel: input.requestedModel,
      temperature: attempt === 0 ? input.temperature : 0,
      responseFormat: { type: 'json_object' },
      messages,
    });

    const raw = extractText(response.choices[0]?.message?.content);
    lastRaw = raw;

    const strictParsed = parseJsonWithSchema(raw, input.schema);
    if (strictParsed) return strictParsed;

    const looseParsed = parseLooseJson(raw);
    if (input.coerceObject && looseParsed) {
      const coerced = input.schema.safeParse(input.coerceObject(looseParsed));
      if (coerced.success) return coerced.data;
    }

    if (input.salvageFromText) {
      const salvaged = input.salvageFromText(raw);
      if (salvaged) {
        const recovered = input.schema.safeParse(salvaged);
        if (recovered.success) return recovered.data;
      }
    }
  }

  const compactRaw = lastRaw.replace(/\s+/g, ' ').slice(0, 240);
  console.error(`${input.label} JSON parse failed.`, { rawPreview: compactRaw });
  throw new Error(`${input.label} JSON parse failed.`);
}

function toUserFacingLlmError(stage: 'scene' | 'check-plan', error: unknown): Error {
  const status = typeof error === 'object' && error && 'status' in error ? Number(error.status) : undefined;
  const message = error instanceof Error ? error.message : String(error);

  if (status === 401 || status === 403) {
    return new Error('OpenAI API 인증에 실패했습니다. 키/권한을 확인해 주세요.');
  }
  if (status === 429) {
    return new Error('OpenAI 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.');
  }
  if (message.includes('JSON parse failed')) {
    if (stage === 'scene') {
      return new Error('장면 생성 중 LLM 응답 형식이 올바르지 않았습니다. 다시 시도해 주세요.');
    }
    return new Error('판정 설계 생성 중 LLM 응답 형식이 올바르지 않았습니다. 다시 시도해 주세요.');
  }

  if (stage === 'scene') {
    return new Error(`장면 생성 중 LLM 응답을 처리하지 못했습니다: ${message}`);
  }
  return new Error(`판정 설계 생성 중 LLM 응답을 처리하지 못했습니다: ${message}`);
}

function parseLooseJson(raw: string): unknown | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const candidates = [trimmed, extractJsonBlock(trimmed)].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try {
      return parsePossiblyNestedJson(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

function coerceSceneObject(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;

  const summary = nonEmpty(source.summary) ?? nonEmpty(source.title) ?? '현재 상황';
  const sceneDescription = nonEmpty(source.sceneDescription) ?? nonEmpty(source.description) ?? summary;
  const choicesHint = asStringArray(source.choicesHint ?? source.choices ?? source.hints).slice(0, 5);
  const importantEntities = asEntityArray(source.importantEntities ?? source.entities).slice(0, 8);

  return {
    summary,
    sceneDescription,
    choicesHint,
    importantEntities,
    requiresChecks: [],
  };
}

function coerceActionPlanObject(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const rawResolutions = Array.isArray(source.resolutions) ? source.resolutions : [];

  const resolutions = rawResolutions
    .map((item, index) => {
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      const actionText = nonEmpty(row.actionText) ?? `행동 ${index + 1}`;
      const checkRequired = typeof row.checkRequired === 'boolean' ? row.checkRequired : true;
      return {
        playerId: nonEmpty(row.playerId) ?? `player-${index + 1}`,
        actionText,
        checkRequired,
        checkType: normalizeAbility(row.checkType),
        skill: asNullableString(row.skill),
        dice: 'd20',
        dc: clampDc(toFiniteNumber(row.dc, 12)),
        reason: nonEmpty(row.reason) ?? '행동 판정이 필요합니다.',
        preRollNarrative: nonEmpty(row.preRollNarrative) ?? `${actionText}의 결과를 확인합니다.`,
        successOutcome: nonEmpty(row.successOutcome) ?? '행동이 의도대로 성공합니다.',
        partialOutcome: nonEmpty(row.partialOutcome) ?? '일부 성과가 있지만 대가가 따릅니다.',
        failureOutcome: nonEmpty(row.failureOutcome) ?? '행동이 실패해 상황이 불리해집니다.',
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  return { resolutions };
}

function salvageSceneFromRawText(text: string): unknown | null {
  const summary = extractQuotedField(text, 'summary');
  const sceneDescription = extractQuotedField(text, 'sceneDescription');
  if (!summary || !sceneDescription) return null;

  return {
    summary,
    sceneDescription,
    choicesHint: extractQuotedArrayField(text, 'choicesHint'),
    importantEntities: [],
    requiresChecks: [],
  };
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
}

function asEntityArray(value: unknown): Array<{ name: string; type: (typeof ENTITY_TYPES)[number] }> {
  if (!Array.isArray(value)) return [];

  const entities: Array<{ name: string; type: (typeof ENTITY_TYPES)[number] }> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const name = nonEmpty(row.name);
    if (!name) continue;
    entities.push({
      name,
      type: normalizeEntityType(row.type),
    });
  }
  return entities;
}

function normalizeEntityType(value: unknown): (typeof ENTITY_TYPES)[number] {
  if (typeof value !== 'string') return 'object';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'npc' || normalized === 'character' || normalized === 'ally') return 'npc';
  if (normalized === 'enemy' || normalized === 'monster' || normalized === 'foe') return 'enemy';
  if (normalized === 'location' || normalized === 'place' || normalized === 'area') return 'location';
  return 'object';
}

function normalizeAbility(value: unknown): (typeof ABILITIES)[number] {
  if (typeof value !== 'string') return 'wisdom';
  const normalized = value.trim().toLowerCase();
  if (ABILITY_SET.has(normalized)) return normalized as (typeof ABILITIES)[number];
  return 'wisdom';
}

function toFiniteNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function extractQuotedField(text: string, field: string): string | null {
  const pattern = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 'i');
  const matched = text.match(pattern)?.[1];
  if (!matched) return null;
  try {
    return JSON.parse(`"${matched}"`) as string;
  } catch {
    return matched;
  }
}

function extractQuotedArrayField(text: string, field: string): string[] {
  const pattern = new RegExp(`"${field}"\\s*:\\s*\\[([\\s\\S]*?)\\]`, 'i');
  const block = text.match(pattern)?.[1];
  if (!block) return [];
  const values: string[] = [];
  const itemPattern = /"((?:\\.|[^"\\])*)"/g;
  let matched: RegExpExecArray | null = itemPattern.exec(block);
  while (matched) {
    try {
      values.push(JSON.parse(`"${matched[1]}"`) as string);
    } catch {
      values.push(matched[1]);
    }
    matched = itemPattern.exec(block);
  }
  return values;
}
