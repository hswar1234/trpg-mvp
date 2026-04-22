'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DEFAULT_SCENARIO } from '../lib/scenarios';
import { ALLOWED_LLM_MODELS, DEFAULT_LLM_MODEL } from '../lib/llm-models';

type RoomListItem = {
  id: string;
  roomCode: string;
  name: string;
  scenarioTheme: string;
  llmModel: string;
  ruleset: string;
  maxPlayers: number;
  playerCount: number;
  gameStatus: string;
  turnMode: string;
  isPrivate: boolean;
  statGenerationMode: string;
  rollMode: string;
};

export default function HomePage() {
  const router = useRouter();
  const [rooms, setRooms] = useState<RoomListItem[]>([]);
  const [loadingRooms, setLoadingRooms] = useState(false);
  const [createPending, setCreatePending] = useState(false);
  const [joinPending, setJoinPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [nickname, setNickname] = useState('');
  const [roomName, setRoomName] = useState('폐허 성당 탐험');
  const [scenarioTheme, setScenarioTheme] = useState(DEFAULT_SCENARIO.name);
  const [ruleset, setRuleset] = useState('d20-basic');
  const [llmModel, setLlmModel] = useState<string>(DEFAULT_LLM_MODEL);
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [isPrivate, setIsPrivate] = useState(false);
  const [password, setPassword] = useState('');
  const [turnMode, setTurnMode] = useState<'simultaneous' | 'sequential'>('simultaneous');
  const [rollMode, setRollMode] = useState<'manual_input' | 'server_auto'>('manual_input');
  const [statGenerationMode, setStatGenerationMode] = useState<'standard_array' | 'balanced' | 'heroic'>(
    'standard_array'
  );

  const [joinCode, setJoinCode] = useState('');
  const [joinPassword, setJoinPassword] = useState('');

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const initTimer = window.setTimeout(() => {
      const nicknameKey = 'trpg:nickname';
      const storedNickname = window.localStorage.getItem(nicknameKey)?.trim();
      if (storedNickname) {
        setNickname(storedNickname);
        return;
      }
      const generated = createRandomNickname();
      setNickname(generated);
      window.localStorage.setItem(nicknameKey, generated);
    }, 0);

    void fetchRooms();
    const timer = window.setInterval(() => {
      void fetchRooms();
    }, 7_000);
    const onFocus = () => {
      void fetchRooms();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearTimeout(initTimer);
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  function ensureUserId(): string {
    if (typeof window === 'undefined') return '';
    const key = 'trpg:user-id';
    const existing = window.localStorage.getItem(key);
    if (existing) return existing;
    const created = window.crypto.randomUUID();
    window.localStorage.setItem(key, created);
    return created;
  }

  async function fetchRooms() {
    setLoadingRooms(true);
    try {
      const response = await fetch('/api/rooms', { cache: 'no-store' });
      const data = (await response.json()) as RoomListItem[];
      setRooms(data);
    } catch (fetchError) {
      console.error(fetchError);
      setError('방 목록을 불러오지 못했습니다.');
    } finally {
      setLoadingRooms(false);
    }
  }

  async function onCreateRoom(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setCreatePending(true);

    try {
      const currentUserId = ensureUserId();
      if (!currentUserId) {
        throw new Error('사용자 ID를 생성하는 중입니다. 잠시 후 다시 시도해 주세요.');
      }
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('trpg:nickname', nickname);
      }

      const response = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomName,
          scenarioTheme,
          llmModel,
          ruleset,
          maxPlayers,
          isPrivate,
          password: isPrivate ? password : undefined,
          turnMode,
          statGenerationMode,
          rollMode,
          hostUserId: currentUserId,
          hostNickname: nickname,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error ?? '방 생성에 실패했습니다.');
      }

      const created = (await response.json()) as { id: string };
      router.push(`/room/${created.id}?uid=${encodeURIComponent(currentUserId)}&nick=${encodeURIComponent(nickname)}`);
    } catch (createError) {
      console.error(createError);
      setError(createError instanceof Error ? createError.message : '방 생성 오류');
    } finally {
      setCreatePending(false);
    }
  }

  async function onJoinByCode(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setJoinPending(true);

    try {
      const currentUserId = ensureUserId();
      if (!currentUserId) {
        throw new Error('사용자 ID를 생성하지 못했습니다. 새로고침 후 다시 시도해 주세요.');
      }
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('trpg:nickname', nickname);
      }

      const response = await fetch('/api/rooms/join-by-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: joinCode,
          userId: currentUserId,
          nickname,
          password: joinPassword || undefined,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error ?? '방 코드 입장에 실패했습니다.');
      }

      const joined = (await response.json()) as { roomId: string };
      router.push(`/room/${joined.roomId}?uid=${encodeURIComponent(currentUserId)}&nick=${encodeURIComponent(nickname)}`);
    } catch (joinError) {
      console.error(joinError);
      setError(joinError instanceof Error ? joinError.message : '방 코드 입장 오류');
    } finally {
      setJoinPending(false);
    }
  }

  function goToRoom(roomId: string) {
    const currentUserId = ensureUserId();
    if (!currentUserId) {
      setError('사용자 ID를 생성하지 못했습니다. 새로고침 후 다시 시도해 주세요.');
      return;
    }
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('trpg:nickname', nickname);
    }
    router.push(`/room/${roomId}?uid=${encodeURIComponent(currentUserId)}&nick=${encodeURIComponent(nickname)}`);
  }

  return (
    <main className="mx-auto min-h-screen w-full max-w-[1320px] px-6 py-8">
      <header className="mb-8">
        <h1 className="text-4xl font-bold tracking-wide">Chronicle Forge MVP</h1>
        <p className="mt-2 text-sm text-[color:var(--ink-2)]">
          온라인 보드게임처럼 방을 만들고, 인앱 d20 굴림과 행동 제출로 턴을 진행하는 LLM TRPG
        </p>
      </header>

      <section className="grid gap-6 lg:grid-cols-[1.15fr_1fr]">
        <article className="board-panel p-5">
          <h2 className="mb-4 text-2xl">방 만들기</h2>
          <form className="grid gap-3" onSubmit={onCreateRoom}>
            <label className="grid gap-1 text-sm">
              닉네임
              <input value={nickname} onChange={(event) => setNickname(event.target.value)} required />
            </label>
            <label className="grid gap-1 text-sm">
              방 이름
              <input value={roomName} onChange={(event) => setRoomName(event.target.value)} required />
            </label>
            <label className="grid gap-1 text-sm">
              주제 / 세계관
              <input value={scenarioTheme} onChange={(event) => setScenarioTheme(event.target.value)} required />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1 text-sm">
                LLM 모델
                <select value={llmModel} onChange={(event) => setLlmModel(event.target.value)}>
                  {ALLOWED_LLM_MODELS.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                룰셋
                <input value={ruleset} onChange={(event) => setRuleset(event.target.value)} required />
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="grid gap-1 text-sm">
                최대 인원
                <input
                  type="number"
                  min={2}
                  max={8}
                  value={maxPlayers}
                  onChange={(event) => setMaxPlayers(Number(event.target.value))}
                />
              </label>
              <label className="grid gap-1 text-sm">
                턴 모드
                <select value={turnMode} onChange={(event) => setTurnMode(event.target.value as 'simultaneous' | 'sequential')}>
                  <option value="simultaneous">동시 제출</option>
                  <option value="sequential">순차 진행</option>
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                능력치 생성
                <select
                  value={statGenerationMode}
                  onChange={(event) =>
                    setStatGenerationMode(event.target.value as 'standard_array' | 'balanced' | 'heroic')
                  }
                >
                  <option value="standard_array">표준 배열</option>
                  <option value="balanced">균형형</option>
                  <option value="heroic">영웅형</option>
                </select>
              </label>
            </div>
            <label className="grid gap-1 text-sm">
              주사위 모드
              <select value={rollMode} onChange={(event) => setRollMode(event.target.value as 'manual_input' | 'server_auto')}>
                <option value="manual_input">인앱 굴림 (플레이어 직접)</option>
                <option value="server_auto">서버 자동 굴림</option>
              </select>
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input
                className="h-4 w-4"
                type="checkbox"
                checked={isPrivate}
                onChange={(event) => setIsPrivate(event.target.checked)}
              />
              비공개 방
            </label>

            {isPrivate ? (
              <label className="grid gap-1 text-sm">
                비밀번호
                <input value={password} onChange={(event) => setPassword(event.target.value)} required />
              </label>
            ) : null}

            {error ? <p className="text-sm text-[color:var(--danger)]">{error}</p> : null}

            <button className="button-primary mt-1" disabled={createPending}>
              {createPending ? '생성 중...' : '방 생성 후 입장'}
            </button>
          </form>

          <hr className="my-5 border-[color:var(--line)]" />

          <h3 className="mb-3 text-lg font-semibold">방 코드로 입장</h3>
          <form className="grid gap-3" onSubmit={onJoinByCode}>
            <label className="grid gap-1 text-sm">
              방 코드
              <input
                value={joinCode}
                onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                placeholder="예: 1A2B3C"
                required
              />
            </label>
            <label className="grid gap-1 text-sm">
              비밀번호(비공개 방일 때)
              <input value={joinPassword} onChange={(event) => setJoinPassword(event.target.value)} />
            </label>
            <button className="button-subtle" disabled={joinPending}>
              {joinPending ? '입장 중...' : '코드로 입장'}
            </button>
          </form>
        </article>

        <article className="board-panel p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-2xl">공개 방 목록</h2>
            <button className="button-subtle text-sm" onClick={() => void fetchRooms()}>
              새로고침
            </button>
          </div>
          {loadingRooms ? <p className="text-sm">불러오는 중...</p> : null}
          <ul className="grid gap-3">
            {rooms.length === 0 ? <li className="text-sm text-[color:var(--ink-2)]">현재 공개된 방이 없습니다.</li> : null}
            {rooms.map((room) => (
              <li key={room.id} className="rounded-xl border border-[color:var(--line)] bg-[#fff7e7] p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <strong>{room.name}</strong>
                  <span className="chip">{room.gameStatus}</span>
                </div>
                <p className="mb-2 text-sm text-[color:var(--ink-2)]">{room.scenarioTheme}</p>
                <div className="mb-2 flex flex-wrap gap-1 text-xs">
                  <span className="chip">코드: {room.roomCode}</span>
                  <span className="chip">
                    {room.playerCount}/{room.maxPlayers}명
                  </span>
                  <span className="chip">{room.turnMode}</span>
                  <span className="chip">{room.ruleset}</span>
                  <span className="chip">{room.llmModel}</span>
                </div>
                <button className="button-primary inline-block text-sm" onClick={() => goToRoom(room.id)}>
                  입장
                </button>
              </li>
            ))}
          </ul>
        </article>
      </section>
    </main>
  );
}

function createRandomNickname(): string {
  const prefixes = ['Silent', 'Amber', 'Iron', 'Swift', 'Rune', 'Ivory', 'Crimson', 'Misty'];
  const suffixes = ['Fox', 'Mage', 'Rider', 'Hunter', 'Bard', 'Knight', 'Scout', 'Diver'];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)] ?? 'Brave';
  const suffix = suffixes[Math.floor(Math.random() * suffixes.length)] ?? 'Player';
  const number = String(Math.floor(Math.random() * 90) + 10);
  return `${prefix}${suffix}${number}`;
}
