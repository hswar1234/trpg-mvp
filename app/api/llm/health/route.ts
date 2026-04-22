import OpenAI from 'openai';
import { NextRequest, NextResponse } from 'next/server';
import { ALLOWED_LLM_MODELS, DEFAULT_LLM_MODEL } from '../../../../lib/llm-models';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const rawModel = request.nextUrl.searchParams.get('model')?.trim();
  const model = rawModel && ALLOWED_LLM_MODELS.includes(rawModel) ? rawModel : DEFAULT_LLM_MODEL;

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      {
        ok: false,
        model,
        error: 'OPENAI_API_KEY is missing on server.',
      },
      { status: 500 }
    );
  }

  const client = new OpenAI({ apiKey });

  try {
    const response = await client.chat.completions.create({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'Return JSON only.',
        },
        {
          role: 'user',
          content: '{"status":"ok","token":"LLM_OK"}',
        },
      ],
    });

    const content = response.choices[0]?.message?.content ?? '';

    return NextResponse.json({
      ok: true,
      model,
      reply: content,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    const status = typeof error === 'object' && error && 'status' in error ? Number(error.status) : 500;
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : undefined;
    const message = error instanceof Error ? error.message : String(error);

    return NextResponse.json(
      {
        ok: false,
        model,
        code,
        error: message,
      },
      { status: Number.isFinite(status) ? status : 500 }
    );
  }
}
