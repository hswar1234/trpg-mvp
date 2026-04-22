'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { getSocket } from '../../../lib/socket';
import { ALLOWED_LLM_MODELS } from '../../../lib/llm-models';
import type { CharacterStats, RoomSnapshot, RollMode, TurnMode, TurnStatus } from '../../../lib/types';

type Notice = {
  kind: 'info' | 'error';
  text: string;
};

type CharacterFormState = {
  name: string;
  role: string;
  hp: string;
  mp: string;
  stats: Record<keyof CharacterStats, string>;
  skills: {
    persuasion: string;
    stealth: string;
    investigation: string;
  };
};

type ParsedResultLog = {
  actionText: string;
  d20: number;
  total: number;
  outcome: 'failed' | 'partial' | 'success';
  preRollNarrative?: string;
  consequence?: string;
};

type ParsedCheckReason = {
  reason: string;
  preRollNarrative: string;
  successOutcome: string;
  partialOutcome: string;
  failureOutcome: string;
};

const TURN_STATUS_LABEL: Record<TurnStatus, string> = {
  action_waiting: '행동 대기',
  roll_waiting: '주사위 대기',
  resolving: '판정 계산',
  next_scene: '다음 장면 준비',
};

const ABILITY_ORDER: Array<keyof CharacterStats> = [
  'strength',
  'dexterity',
  'constitution',
  'intelligence',
  'wisdom',
  'charisma',
];

const ABILITY_LABELS: Record<keyof CharacterStats, string> = {
  strength: 'STR',
  dexterity: 'DEX',
  intelligence: 'INT',
  charisma: 'CHA',
  constitution: 'CON',
  wisdom: 'WIS',
};

export default function RoomPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();

  const roomId = params.id;
  const userId = searchParams.get('uid') ?? '';
  const nickname = searchParams.get('nick') ?? 'Player';

  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [joining, setJoining] = useState(true);

  const [actionText, setActionText] = useState('');
  const [pendingActionSubmit, setPendingActionSubmit] = useState(false);
  const [pendingGameStart, setPendingGameStart] = useState(false);
  const [pendingConfigSave, setPendingConfigSave] = useState(false);
  const [pendingCharacterSave, setPendingCharacterSave] = useState(false);
  const [pendingReadyToggle, setPendingReadyToggle] = useState(false);
  const [pendingLeave, setPendingLeave] = useState(false);

  const [configDirty, setConfigDirty] = useState(false);
  const [hostTurnMode, setHostTurnMode] = useState<TurnMode>('simultaneous');
  const [hostRollMode, setHostRollMode] = useState<RollMode>('manual_input');
  const [hostLlmModel, setHostLlmModel] = useState<string>(ALLOWED_LLM_MODELS[0] ?? 'gpt-5.4');

  const [characterForm, setCharacterForm] = useState<CharacterFormState>(() => buildCharacterForm(null));
  const [characterDirty, setCharacterDirty] = useState(false);

  const [rollingCheckId, setRollingCheckId] = useState<string | null>(null);
  const [lastRolledValues, setLastRolledValues] = useState<Record<string, number>>({});
  const manualLeaveRef = useRef(false);

  const me = useMemo(() => {
    if (!snapshot) return null;
    return snapshot.players.find((player) => player.userId === userId) ?? null;
  }, [snapshot, userId]);

  const myPendingChecks = useMemo(() => {
    if (!snapshot || !me) return [];
    return snapshot.checks.filter((check) => check.roomPlayerId === me.roomPlayerId && !check.resolved);
  }, [snapshot, me]);

  const recentResultLogs = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.logs.filter((log) => log.logType === 'result').slice(-3);
  }, [snapshot]);

  const parsedRecentResults = useMemo(
    () =>
      recentResultLogs
        .map((log) => parseResultLog(log.content))
        .filter((item): item is ParsedResultLog => item !== null),
    [recentResultLogs]
  );
  const currentMainSceneText = useMemo(
    () => toMainSceneDescription(snapshot?.scene?.sceneDescription),
    [snapshot?.scene?.sceneDescription]
  );

  useEffect(() => {
    if (!roomId || !userId) {
      router.replace('/');
      return;
    }

    const socket = getSocket();
    if (!socket.connected) socket.connect();

    const onRoomUpdate = (nextSnapshot: RoomSnapshot) => {
      setSnapshot(nextSnapshot);
    };
    const onServerError = (payload: { message: string }) => {
      setNotice({ kind: 'error', text: payload.message });
    };
    const onTurnScene = () => {
      setNotice({ kind: 'info', text: '새 턴이 시작되었습니다.' });
    };
    const onCheckRequested = () => {
      setNotice({ kind: 'info', text: '주사위를 굴려 판정을 제출하세요.' });
    };

    socket.on('room:update', onRoomUpdate);
    socket.on('server:error', onServerError);
    socket.on('turn:scene', onTurnScene);
    socket.on('check:requested', onCheckRequested);

    const requestSync = () => {
      socket.emit('room:sync', { roomId }, (result) => {
        if (result.ok && result.data) {
          setSnapshot(result.data);
        }
      });
    };
    const onConnect = () => {
      requestSync();
    };
    socket.on('connect', onConnect);
    const syncTimer = window.setInterval(requestSync, 7_000);

    socket.emit(
      'room:join',
      {
        roomId,
        userId,
        nickname,
      },
      (result) => {
        setJoining(false);
        if (!result.ok) {
          setNotice({ kind: 'error', text: result.error ?? '방 입장에 실패했습니다.' });
          return;
        }
        if (result.data?.snapshot) {
          const initialSnapshot = result.data.snapshot;
          setSnapshot(initialSnapshot);
          setHostTurnMode(initialSnapshot.room.turnMode);
          setHostRollMode(initialSnapshot.room.rollMode);
          setHostLlmModel(initialSnapshot.room.llmModel);
          const mine = initialSnapshot.players.find((player) => player.userId === userId);
          setCharacterForm(buildCharacterForm(mine?.character ?? null));
        }
      }
    );

    return () => {
      if (!manualLeaveRef.current) {
        socket.emit('room:leave', { roomId }, () => undefined);
      }
      window.clearInterval(syncTimer);
      socket.off('room:update', onRoomUpdate);
      socket.off('server:error', onServerError);
      socket.off('turn:scene', onTurnScene);
      socket.off('check:requested', onCheckRequested);
      socket.off('connect', onConnect);
    };
  }, [nickname, roomId, router, userId]);

  function startGame() {
    if (!roomId) return;
    const socket = getSocket();
    setPendingGameStart(true);
    socket.emit('game:start', { roomId }, (result) => {
      setPendingGameStart(false);
      if (!result.ok) {
        setNotice({ kind: 'error', text: result.error ?? '게임 시작에 실패했습니다.' });
      } else {
        setConfigDirty(false);
        setCharacterDirty(false);
      }
    });
  }

  function endGame() {
    if (!roomId) return;
    const socket = getSocket();
    socket.emit('game:end', { roomId }, (result) => {
      if (!result.ok) {
        setNotice({ kind: 'error', text: result.error ?? '게임 종료에 실패했습니다.' });
      }
    });
  }

  function toggleReady(nextReady: boolean) {
    if (!roomId || !snapshot || !me) return;
    if (snapshot.room.gameStatus !== 'waiting') return;

    const socket = getSocket();
    setPendingReadyToggle(true);
    socket.emit('player:ready', { roomId, ready: nextReady }, (result) => {
      setPendingReadyToggle(false);
      if (!result.ok) {
        setNotice({ kind: 'error', text: result.error ?? '준비 상태 변경에 실패했습니다.' });
        return;
      }
      if (result.data) setSnapshot(result.data);
      setNotice({ kind: 'info', text: nextReady ? '준비 완료 상태로 전환했습니다.' : '준비를 해제했습니다.' });
    });
  }

  function leaveRoomNow() {
    if (!roomId || !snapshot) return;
    if (snapshot.room.gameStatus === 'waiting' && me?.isReady) {
      setNotice({ kind: 'error', text: '준비 중에는 나갈 수 없습니다. 준비를 해제해 주세요.' });
      return;
    }

    const socket = getSocket();
    setPendingLeave(true);
    manualLeaveRef.current = true;
    socket.emit('room:leave', { roomId }, (result) => {
      setPendingLeave(false);
      if (!result.ok) {
        manualLeaveRef.current = false;
        setNotice({ kind: 'error', text: result.error ?? '방 나가기에 실패했습니다.' });
        return;
      }
      router.push('/');
    });
  }

  function saveRoomConfig() {
    if (!roomId || !snapshot) return;
    if (snapshot.room.gameStatus !== 'waiting') {
      setNotice({ kind: 'error', text: '게임 시작 후에는 방 설정을 변경할 수 없습니다.' });
      return;
    }

    const socket = getSocket();
    setPendingConfigSave(true);

    socket.emit(
      'room:config:update',
      {
        roomId,
        turnMode: visibleTurnMode(snapshot, configDirty, hostTurnMode),
        rollMode: visibleRollMode(snapshot, configDirty, hostRollMode),
        llmModel: visibleLlmModel(snapshot, configDirty, hostLlmModel),
      },
      (result) => {
        setPendingConfigSave(false);
        if (!result.ok) {
          setNotice({ kind: 'error', text: result.error ?? '방 설정 저장에 실패했습니다.' });
          return;
        }
        if (result.data) {
          setSnapshot(result.data);
          setHostTurnMode(result.data.room.turnMode);
          setHostRollMode(result.data.room.rollMode);
          setHostLlmModel(result.data.room.llmModel);
          setConfigDirty(false);
        }
        setNotice({ kind: 'info', text: '방 설정을 저장했습니다.' });
      }
    );
  }

  function submitAction() {
    if (!roomId || !actionText.trim()) return;

    const socket = getSocket();
    setPendingActionSubmit(true);
    socket.emit(
      'action:submit',
      {
        roomId,
        actionText: actionText.trim(),
      },
      (result) => {
        setPendingActionSubmit(false);
        if (!result.ok) {
          setNotice({ kind: 'error', text: result.error ?? '행동 제출에 실패했습니다.' });
          return;
        }
        setActionText('');
      }
    );
  }

  function submitRoll(checkId: string, diceResult: number) {
    if (!roomId || !snapshot) return;

    if (snapshot.room.rollMode === 'manual_input' && (!Number.isInteger(diceResult) || diceResult < 1 || diceResult > 20)) {
      setNotice({ kind: 'error', text: 'd20 결과는 1~20 정수여야 합니다.' });
      return;
    }

    const socket = getSocket();
    socket.emit(
      'roll:submit',
      {
        roomId,
        checkId,
        diceResult,
      },
      (result) => {
        if (!result.ok) {
          setNotice({ kind: 'error', text: result.error ?? '주사위 제출에 실패했습니다.' });
          return;
        }
      }
    );
  }

  function rollInApp(checkId: string) {
    if (rollingCheckId) return;
    const rolled = rollD20();
    setLastRolledValues((prev) => ({ ...prev, [checkId]: rolled }));
    setRollingCheckId(checkId);

    window.setTimeout(() => {
      submitRoll(checkId, rolled);
      setRollingCheckId(null);
    }, 450);
  }

  function saveCharacter() {
    if (!roomId || !snapshot) return;
    if (snapshot.room.gameStatus !== 'waiting') {
      setNotice({ kind: 'error', text: '게임 시작 후에는 캐릭터 설정을 변경할 수 없습니다.' });
      return;
    }

    const activeForm = characterDirty ? characterForm : buildCharacterForm(me?.character ?? null);
    const name = activeForm.name.trim();
    const role = activeForm.role.trim();
    if (!name || !role) {
      setNotice({ kind: 'error', text: '캐릭터 이름과 역할을 입력하세요.' });
      return;
    }

    const hp = toBoundedInt(activeForm.hp, 12, 1, 200);
    const mp = toBoundedInt(activeForm.mp, 6, 0, 200);
    const stats: CharacterStats = {
      strength: toBoundedInt(activeForm.stats.strength, 10, 1, 20),
      dexterity: toBoundedInt(activeForm.stats.dexterity, 10, 1, 20),
      intelligence: toBoundedInt(activeForm.stats.intelligence, 10, 1, 20),
      charisma: toBoundedInt(activeForm.stats.charisma, 10, 1, 20),
      constitution: toBoundedInt(activeForm.stats.constitution, 10, 1, 20),
      wisdom: toBoundedInt(activeForm.stats.wisdom, 10, 1, 20),
    };
    const skills = {
      persuasion: toBoundedInt(activeForm.skills.persuasion, 0, -5, 20),
      stealth: toBoundedInt(activeForm.skills.stealth, 0, -5, 20),
      investigation: toBoundedInt(activeForm.skills.investigation, 0, -5, 20),
    };

    const socket = getSocket();
    setPendingCharacterSave(true);
    socket.emit(
      'character:update',
      {
        roomId,
        name,
        role,
        hp,
        mp,
        stats,
        skills,
      },
      (result) => {
        setPendingCharacterSave(false);
        if (!result.ok) {
          setNotice({ kind: 'error', text: result.error ?? '캐릭터 저장에 실패했습니다.' });
          return;
        }

        if (result.data) {
          setSnapshot(result.data);
          const mine = result.data.players.find((player) => player.userId === userId);
          setCharacterForm(buildCharacterForm(mine?.character ?? null));
        }
        setCharacterDirty(false);
        setNotice({ kind: 'info', text: '캐릭터 시트를 저장했습니다.' });
      }
    );
  }

  if (joining || !snapshot) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-[1320px] items-center justify-center px-6">
        <section className="board-panel w-full max-w-lg p-6 text-center">
          <h1 className="text-2xl">방 입장 중...</h1>
          <p className="mt-2 text-sm text-[color:var(--ink-2)]">소켓 연결과 방 상태를 확인하고 있습니다.</p>
        </section>
      </main>
    );
  }

  const isWaiting = snapshot.room.gameStatus === 'waiting';
  const isPlaying = snapshot.room.gameStatus === 'in_progress';
  const setupLocked = !isWaiting;

  const connectedPlayers = snapshot.players.filter((player) => player.connected);
  const unreadyConnectedPlayers = connectedPlayers.filter((player) => !player.isReady);
  const showStartButton = Boolean(me?.isHost && isWaiting);
  const canStart =
    Boolean(me?.isHost && isWaiting) &&
    connectedPlayers.length > 0 &&
    unreadyConnectedPlayers.length === 0;
  const canEnd = Boolean(me?.isHost && isPlaying);
  const myActionSubmitted = Boolean(me && snapshot.actions.some((action) => action.roomPlayerId === me.roomPlayerId));
  const canSubmitAction = Boolean(isPlaying && snapshot.currentTurn?.status === 'action_waiting' && !myActionSubmitted);
  const pendingActionCount = snapshot.pendingActionPlayerIds.length;
  const pendingRollCount = snapshot.pendingRollPlayerIds.length;

  const modeTurn = visibleTurnMode(snapshot, configDirty, hostTurnMode);
  const modeRoll = visibleRollMode(snapshot, configDirty, hostRollMode);
  const modeLlmModel = visibleLlmModel(snapshot, configDirty, hostLlmModel);
  const activeCharacterForm = characterDirty ? characterForm : buildCharacterForm(me?.character ?? null);
  const connectedPlayerCount = connectedPlayers.length;
  const leaveBlockedByReady = Boolean(isWaiting && me?.isReady);
  const currentTaskMessage = getCurrentTaskMessage({
    isWaiting,
    turnStatus: snapshot.currentTurn?.status,
    myActionSubmitted,
    myPendingChecks: myPendingChecks.length,
    pendingActionCount,
    pendingRollCount,
  });

  return (
    <main className="mx-auto min-h-screen w-full max-w-[1400px] px-5 py-5">
      <header className="board-panel mb-4 flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <h1 className="text-3xl">{snapshot.room.name}</h1>
          <p className="text-sm text-[color:var(--ink-2)]">
            시나리오: {snapshot.room.scenarioTheme} | 방 코드: {snapshot.room.roomCode} | 턴 #{snapshot.currentTurn?.turnNumber ?? '-'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="chip">
            {connectedPlayerCount}/{snapshot.room.maxPlayers}명
          </span>
          <span className="chip">상태: {snapshot.currentTurn ? TURN_STATUS_LABEL[snapshot.currentTurn.status] : '대기'}</span>
          <span className="chip">턴 모드: {toTurnModeLabel(snapshot.room.turnMode)}</span>
          <span className="chip">주사위: {toRollModeLabel(snapshot.room.rollMode)}</span>
          {isWaiting && me ? (
            <button
              className="button-subtle text-sm"
              onClick={() => toggleReady(!me.isReady)}
              disabled={pendingReadyToggle}
            >
              {pendingReadyToggle ? '처리 중...' : me.isReady ? '준비 해제' : '게임 준비'}
            </button>
          ) : null}
          {showStartButton ? (
            <button className="button-primary text-sm" onClick={startGame} disabled={pendingGameStart || !canStart}>
              {pendingGameStart
                ? '게임 시작 중...'
                : canStart
                  ? '게임 시작'
                  : `준비 대기 (${unreadyConnectedPlayers.length})`}
            </button>
          ) : null}
          {canEnd ? (
            <button className="button-subtle text-sm" onClick={endGame}>
              게임 종료
            </button>
          ) : null}
          <button className="button-subtle text-sm" onClick={leaveRoomNow} disabled={pendingLeave || leaveBlockedByReady}>
            {pendingLeave ? '나가는 중...' : '방 나가기'}
          </button>
        </div>
      </header>

      {notice ? (
        <p
          className={`mb-3 rounded-md px-3 py-2 text-sm ${
            notice.kind === 'error' ? 'bg-[#ffe5df] text-[color:var(--danger)]' : 'bg-[#ecf5df] text-[color:var(--ok)]'
          }`}
        >
          {notice.text}
        </p>
      ) : null}

      <section className="board-panel mb-4 p-4">
        <h2 className="mb-2 text-lg">턴 진행 상태</h2>
        <p className="mb-3 text-sm text-[color:var(--ink-2)]">{currentTaskMessage}</p>
        <div className="grid gap-2 sm:grid-cols-4">
          <FlowStep
            label="1) 행동 제출"
            active={snapshot.currentTurn?.status === 'action_waiting'}
            done={snapshot.currentTurn?.status !== 'action_waiting'}
          />
          <FlowStep
            label="2) 판정 요청"
            active={snapshot.currentTurn?.status === 'roll_waiting'}
            done={snapshot.currentTurn?.status === 'resolving' || snapshot.currentTurn?.status === 'next_scene'}
          />
          <FlowStep
            label="3) 결과 계산"
            active={snapshot.currentTurn?.status === 'resolving'}
            done={snapshot.currentTurn?.status === 'next_scene'}
          />
          <FlowStep label="4) 다음 장면" active={snapshot.currentTurn?.status === 'next_scene'} done={false} />
        </div>
        {parsedRecentResults.length > 0 ? (
          <div className="mt-3 grid gap-2">
            {parsedRecentResults.map((result, index) => (
              <article key={`${result.actionText}-${index}`} className="rounded-lg border border-[color:var(--line)] bg-[#fff8ec] p-2 text-sm">
                <p className="font-semibold">{result.actionText}</p>
                {result.preRollNarrative ? (
                  <p className="mb-1 text-xs text-[color:var(--ink-2)]">{result.preRollNarrative}</p>
                ) : null}
                <p className="text-xs text-[color:var(--ink-2)]">
                  d20 {result.d20} / 총합 {result.total} / 결과: {toOutcomeLabel(result.outcome)}
                </p>
                {result.consequence ? <p className="mt-1 text-xs">{result.consequence}</p> : null}
              </article>
            ))}
          </div>
        ) : null}
      </section>

      {isWaiting ? (
        <section className="grid gap-4 xl:grid-cols-[1.1fr_1fr]">
          <article className="board-panel p-4">
            <h2 className="mb-2 text-xl">게임 시작 대기</h2>
            <p className="mb-3 text-sm text-[color:var(--ink-2)]">
              게임 시작 전에는 진행 패널(장면/행동/로그)이 숨겨집니다. 호스트가 게임 시작 버튼을 누르면 보드가 열립니다.
            </p>
            <div className="rounded-lg border border-[color:var(--line)] bg-[#fff6e7] p-3 text-sm">
              <p>1. 플레이어가 모두 입장합니다.</p>
              <p>2. 호스트가 방 설정을 확정합니다.</p>
              <p>3. 각 플레이어가 캐릭터 시트를 확인/수정합니다.</p>
              <p>4. 호스트가 게임 시작을 누릅니다.</p>
            </div>

            <h3 className="mb-2 mt-4 text-sm font-bold">참가자 현황</h3>
            <ul className="grid gap-2">
              {snapshot.players.map((player) => (
                <li key={player.roomPlayerId} className="rounded-lg border border-[color:var(--line)] bg-[#fff7ec] p-2 text-sm">
                  <div className="mb-1 flex items-center gap-2">
                    <strong>{player.nickname}</strong>
                    {player.isHost ? <span className="chip">HOST</span> : null}
                    {!player.connected ? (
                      <span className="chip">offline</span>
                    ) : player.isReady ? (
                      <span className="chip">ready</span>
                    ) : (
                      <span className="chip">not ready</span>
                    )}
                  </div>
                  {player.character ? (
                    <p className="text-xs text-[color:var(--ink-2)]">
                      {player.character.role} | HP {player.character.hp}/{player.character.maxHp} | MP {player.character.mp}/
                      {player.character.maxMp}
                    </p>
                  ) : (
                    <p className="text-xs text-[color:var(--ink-2)]">캐릭터 미설정</p>
                  )}
                </li>
              ))}
            </ul>
            {me?.isHost && unreadyConnectedPlayers.length > 0 ? (
              <p className="mt-3 text-xs text-[color:var(--ink-2)]">
                시작 대기 중: {unreadyConnectedPlayers.map((player) => player.nickname).join(', ')}
              </p>
            ) : null}
          </article>

          <article className="grid gap-4">
            <section className="board-panel p-4">
              <h2 className="mb-2 text-xl">방 설정</h2>
              <p className="mb-2 text-xs text-[color:var(--ink-2)]">게임 시작 후에는 자동 잠금됩니다.</p>
              <div className="grid gap-2 text-sm">
                <label className="grid gap-1">
                  턴 모드
                  <select
                    value={modeTurn}
                    disabled={!me?.isHost || setupLocked}
                    onChange={(event) => {
                      setConfigDirty(true);
                      setHostTurnMode(event.target.value as TurnMode);
                    }}
                  >
                    <option value="simultaneous">동시 제출</option>
                    <option value="sequential">순차 진행</option>
                  </select>
                </label>
                <label className="grid gap-1">
                  주사위 모드
                  <select
                    value={modeRoll}
                    disabled={!me?.isHost || setupLocked}
                    onChange={(event) => {
                      setConfigDirty(true);
                      setHostRollMode(event.target.value as RollMode);
                    }}
                  >
                    <option value="manual_input">인앱 굴림 (플레이어 직접)</option>
                    <option value="server_auto">서버 자동 굴림</option>
                  </select>
                </label>
                <label className="grid gap-1">
                  LLM 모델
                  <select
                    value={modeLlmModel}
                    disabled={!me?.isHost || setupLocked}
                    onChange={(event) => {
                      setConfigDirty(true);
                      setHostLlmModel(event.target.value);
                    }}
                  >
                    {ALLOWED_LLM_MODELS.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {me?.isHost ? (
                <button className="button-subtle mt-3 text-sm" onClick={saveRoomConfig} disabled={pendingConfigSave || setupLocked}>
                  {pendingConfigSave ? '저장 중...' : '방 설정 저장'}
                </button>
              ) : (
                <p className="mt-3 text-xs text-[color:var(--ink-2)]">방 설정은 호스트만 변경할 수 있습니다.</p>
              )}
            </section>

            <section className="board-panel p-4">
              <h2 className="mb-2 text-xl">내 캐릭터 시트</h2>
              <p className="mb-2 text-xs text-[color:var(--ink-2)]">게임 시작 후에는 자동 잠금됩니다.</p>
              <div className="grid gap-2 text-sm">
                <label className="grid gap-1">
                  이름
                  <input
                    disabled={setupLocked}
                    value={activeCharacterForm.name}
                    onChange={(event) => {
                      setCharacterDirty(true);
                      setCharacterForm({ ...activeCharacterForm, name: event.target.value });
                    }}
                  />
                </label>
                <label className="grid gap-1">
                  역할
                  <input
                    disabled={setupLocked}
                    value={activeCharacterForm.role}
                    onChange={(event) => {
                      setCharacterDirty(true);
                      setCharacterForm({ ...activeCharacterForm, role: event.target.value });
                    }}
                  />
                </label>
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="grid gap-1">
                    HP
                    <input
                      disabled={setupLocked}
                      type="number"
                      min={1}
                      max={200}
                      value={activeCharacterForm.hp}
                      onChange={(event) => {
                        setCharacterDirty(true);
                        setCharacterForm({ ...activeCharacterForm, hp: event.target.value });
                      }}
                    />
                  </label>
                  <label className="grid gap-1">
                    MP
                    <input
                      disabled={setupLocked}
                      type="number"
                      min={0}
                      max={200}
                      value={activeCharacterForm.mp}
                      onChange={(event) => {
                        setCharacterDirty(true);
                        setCharacterForm({ ...activeCharacterForm, mp: event.target.value });
                      }}
                    />
                  </label>
                </div>
              </div>

              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {ABILITY_ORDER.map((ability) => (
                  <label key={ability} className="grid gap-1 text-sm">
                    {ABILITY_LABELS[ability]}
                    <input
                      disabled={setupLocked}
                      type="number"
                      min={1}
                      max={20}
                      value={activeCharacterForm.stats[ability]}
                      onChange={(event) => {
                        setCharacterDirty(true);
                        setCharacterForm({
                          ...activeCharacterForm,
                          stats: {
                            ...activeCharacterForm.stats,
                            [ability]: event.target.value,
                          },
                        });
                      }}
                    />
                  </label>
                ))}
              </div>

              <div className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
                <label className="grid gap-1">
                  설득
                  <input
                    disabled={setupLocked}
                    type="number"
                    min={-5}
                    max={20}
                    value={activeCharacterForm.skills.persuasion}
                    onChange={(event) => {
                      setCharacterDirty(true);
                      setCharacterForm({
                        ...activeCharacterForm,
                        skills: { ...activeCharacterForm.skills, persuasion: event.target.value },
                      });
                    }}
                  />
                </label>
                <label className="grid gap-1">
                  은신
                  <input
                    disabled={setupLocked}
                    type="number"
                    min={-5}
                    max={20}
                    value={activeCharacterForm.skills.stealth}
                    onChange={(event) => {
                      setCharacterDirty(true);
                      setCharacterForm({
                        ...activeCharacterForm,
                        skills: { ...activeCharacterForm.skills, stealth: event.target.value },
                      });
                    }}
                  />
                </label>
                <label className="grid gap-1">
                  조사
                  <input
                    disabled={setupLocked}
                    type="number"
                    min={-5}
                    max={20}
                    value={activeCharacterForm.skills.investigation}
                    onChange={(event) => {
                      setCharacterDirty(true);
                      setCharacterForm({
                        ...activeCharacterForm,
                        skills: { ...activeCharacterForm.skills, investigation: event.target.value },
                      });
                    }}
                  />
                </label>
              </div>

              <button className="button-subtle mt-3 text-sm" onClick={saveCharacter} disabled={pendingCharacterSave || setupLocked}>
                {pendingCharacterSave ? '저장 중...' : '캐릭터 저장'}
              </button>
            </section>
          </article>
        </section>
      ) : (
        <>
          <section className="grid gap-4 xl:grid-cols-[1.2fr_1fr_0.9fr]">
            <article className="board-panel p-4">
              <h2 className="mb-2 text-xl">현재 Scene</h2>
              <p className="mb-2 text-sm text-[color:var(--ink-2)]">{snapshot.scene?.summary ?? '장면 준비 중입니다.'}</p>
              <p className="mb-3 whitespace-pre-wrap text-sm leading-relaxed">{currentMainSceneText}</p>

              <h3 className="mb-1 text-sm font-bold">행동 힌트</h3>
              <ul className="mb-3 grid gap-1 text-sm">
                {(snapshot.scene?.choicesHint ?? []).map((hint, index) => (
                  <li key={`${hint}-${index}`} className="rounded-md bg-[#fff2da] px-2 py-1">
                    {hint}
                  </li>
                ))}
              </ul>

              <h3 className="mb-1 text-sm font-bold">중요 엔티티</h3>
              <div className="flex flex-wrap gap-1">
                {(snapshot.scene?.importantEntities ?? []).map((entity) => (
                  <span key={`${entity.name}-${entity.type}`} className="chip">
                    {entity.name} ({entity.type})
                  </span>
                ))}
              </div>
            </article>

            <article className="board-panel p-4">
              <h2 className="mb-2 text-xl">행동 제출</h2>
              <textarea
                className="min-h-[140px]"
                value={actionText}
                onChange={(event) => setActionText(event.target.value)}
                placeholder="예) 문을 발로 차서 연다"
                disabled={!canSubmitAction}
              />
              <button className="button-primary mt-3" disabled={!canSubmitAction || pendingActionSubmit} onClick={submitAction}>
                {myActionSubmitted ? '이미 제출됨' : pendingActionSubmit ? '제출 중...' : '행동 제출'}
              </button>

              <div className="mt-4">
                <h3 className="mb-2 text-sm font-bold">나의 판정</h3>
                {myPendingChecks.length === 0 ? (
                  <p className="text-xs text-[color:var(--ink-2)]">현재 대기 중인 판정이 없습니다.</p>
                ) : (
                  <ul className="grid gap-2">
                {myPendingChecks.map((check) => (
                  <li key={check.id} className="rounded-lg border border-[color:var(--line)] bg-[#fff5e2] p-3 text-sm">
                    {(() => {
                      const detail = parseCheckReason(check.reason);
                      return (
                        <>
                          <div className="mb-2 flex flex-wrap items-center gap-1">
                            <span className="chip">능력치: {formatCheckAbility(check.checkType)}</span>
                            <span className="chip">기술: {formatCheckSkill(check.skill)}</span>
                            <span className="chip">DC {check.dc}</span>
                          </div>
                          <p className="mb-2 rounded-md border border-[color:var(--line)] bg-[#fffaf0] px-2 py-2 text-xs leading-relaxed text-[color:var(--ink-2)]">
                            {detail.preRollNarrative}
                          </p>
                          <details className="rounded-md border border-[color:var(--line)] bg-[#fff9ee] px-2 py-1 text-xs">
                            <summary className="cursor-pointer font-semibold text-[color:var(--ink-2)]">
                              결과별 서사 보기
                            </summary>
                            <div className="mt-2 grid gap-2 leading-relaxed">
                              <div className="rounded-md border border-[#b8d8b8] bg-[#f3fff3] px-2 py-1">
                                <p className="font-semibold text-[color:var(--ok)]">성공</p>
                                <p>{detail.successOutcome}</p>
                              </div>
                              <div className="rounded-md border border-[color:var(--line)] bg-[#fffdf7] px-2 py-1">
                                <p className="font-semibold text-[color:var(--ink-2)]">부분 성공</p>
                                <p>{detail.partialOutcome}</p>
                              </div>
                              <div className="rounded-md border border-[#e0b4b4] bg-[#fff4f4] px-2 py-1">
                                <p className="font-semibold text-[color:var(--danger)]">실패</p>
                                <p>{detail.failureOutcome}</p>
                              </div>
                            </div>
                          </details>
                          <div className="mb-2 mt-2 h-px bg-[color:var(--line)]" />
                          <p className="mb-2 text-xs font-semibold text-[color:var(--ink-2)]">
                            판정 실행
                          </p>
                          <div className="flex items-center gap-2">
                            {snapshot.room.rollMode === 'manual_input' ? (
                              <>
                                <button
                                  className="button-subtle text-xs"
                                  disabled={rollingCheckId === check.id}
                                  onClick={() => rollInApp(check.id)}
                                >
                                  {rollingCheckId === check.id ? '굴리는 중...' : 'd20 굴리기'}
                                </button>
                                {lastRolledValues[check.id] ? (
                                  <span className="chip">최근 굴림: {lastRolledValues[check.id]}</span>
                                ) : null}
                              </>
                            ) : (
                              <>
                                <span className="text-xs text-[color:var(--ink-2)]">서버 자동 굴림 모드</span>
                                <button className="button-subtle text-xs" onClick={() => submitRoll(check.id, 1)}>
                                  자동 굴림 실행
                                </button>
                              </>
                            )}
                          </div>
                        </>
                      );
                    })()}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </article>

            <article className="grid gap-4">
              <section className="board-panel p-4">
                <h2 className="mb-2 text-xl">플레이어</h2>
                <ul className="grid gap-2">
                  {snapshot.players.map((player) => (
                    <li key={player.roomPlayerId} className="rounded-lg border border-[color:var(--line)] bg-[#fff6e7] p-2 text-sm">
                      <div className="mb-1 flex items-center gap-2">
                        <strong>{player.nickname}</strong>
                        {player.isHost ? <span className="chip">HOST</span> : null}
                        {!player.connected ? <span className="chip">offline</span> : null}
                      </div>
                      <p className="text-xs text-[color:var(--ink-2)]">
                        행동: <b>{player.hasSubmittedAction ? '완료' : snapshot.pendingActionPlayerIds.includes(player.roomPlayerId) ? '대기' : '-'}</b> |
                        판정: <b>{player.hasSubmittedRoll ? '완료' : snapshot.pendingRollPlayerIds.includes(player.roomPlayerId) ? '대기' : '-'}</b>
                      </p>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="board-panel p-4">
                <h3 className="mb-2 text-lg">설정 요약 (잠금)</h3>
                <p className="text-xs text-[color:var(--ink-2)]">게임이 시작되어 방/캐릭터 설정은 잠금되었습니다.</p>
                <div className="mt-2 flex flex-wrap gap-1 text-xs">
                  <span className="chip">턴 모드: {toTurnModeLabel(snapshot.room.turnMode)}</span>
                  <span className="chip">주사위: {toRollModeLabel(snapshot.room.rollMode)}</span>
                  <span className="chip">룰: {snapshot.room.ruleset}</span>
                  <span className="chip">LLM: {snapshot.room.llmModel}</span>
                </div>
              </section>

              <section className="board-panel p-4">
                <h3 className="mb-2 text-lg">내 캐릭터 요약</h3>
                {me?.character ? (
                  <>
                    <p className="text-sm font-semibold">
                      {me.character.name} ({me.character.role})
                    </p>
                    <p className="text-xs text-[color:var(--ink-2)]">
                      HP {me.character.hp}/{me.character.maxHp} | MP {me.character.mp}/{me.character.maxMp}
                    </p>
                    <div className="mt-2 grid grid-cols-3 gap-1 text-xs">
                      {ABILITY_ORDER.map((ability) => (
                        <span key={ability} className="chip">
                          {ABILITY_LABELS[ability]} {me.character?.stats[ability]}
                        </span>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-[color:var(--ink-2)]">캐릭터 정보가 없습니다.</p>
                )}
              </section>
            </article>
          </section>

          <section className="board-panel mt-4 p-4">
            <h2 className="mb-2 text-xl">턴 로그</h2>
            <div className="grid max-h-[260px] gap-2 overflow-y-auto pr-1">
              {snapshot.logs.length === 0 ? <p className="text-sm text-[color:var(--ink-2)]">로그가 없습니다.</p> : null}
              {snapshot.logs.map((log) => (
                <article key={log.id} className="rounded-lg border border-[color:var(--line)] bg-[#fff9ee] p-2 text-sm">
                  <p className="mb-1 text-xs text-[color:var(--ink-2)]">
                    Turn {log.turnNumber} | {log.logType}
                  </p>
                  <p className="whitespace-pre-wrap">{renderLogContent(log.content)}</p>
                </article>
              ))}
            </div>
          </section>
        </>
      )}
    </main>
  );
}

function visibleTurnMode(snapshot: RoomSnapshot, configDirty: boolean, hostTurnMode: TurnMode): TurnMode {
  return configDirty ? hostTurnMode : snapshot.room.turnMode;
}

function visibleRollMode(snapshot: RoomSnapshot, configDirty: boolean, hostRollMode: RollMode): RollMode {
  return configDirty ? hostRollMode : snapshot.room.rollMode;
}

function visibleLlmModel(snapshot: RoomSnapshot, configDirty: boolean, hostLlmModel: string): string {
  return configDirty ? hostLlmModel : snapshot.room.llmModel;
}

function toRollModeLabel(mode: RollMode): string {
  return mode === 'manual_input' ? '인앱 굴림(플레이어)' : '서버 자동 굴림';
}

function toTurnModeLabel(mode: TurnMode): string {
  return mode === 'simultaneous' ? '동시 제출' : '순차 진행';
}

function toOutcomeLabel(outcome: 'failed' | 'partial' | 'success'): string {
  if (outcome === 'success') return '성공';
  if (outcome === 'partial') return '부분 성공';
  return '실패';
}

function formatCheckAbility(ability: string): string {
  const map: Record<string, string> = {
    strength: 'STR',
    dexterity: 'DEX',
    intelligence: 'INT',
    charisma: 'CHA',
    constitution: 'CON',
    wisdom: 'WIS',
  };
  return map[ability] ?? ability;
}

function formatCheckSkill(skill: string | null): string {
  if (!skill) return '없음';
  return skill;
}

function getCurrentTaskMessage(input: {
  isWaiting: boolean;
  turnStatus: TurnStatus | undefined;
  myActionSubmitted: boolean;
  myPendingChecks: number;
  pendingActionCount: number;
  pendingRollCount: number;
}): string {
  if (input.isWaiting) return '준비 단계입니다. 설정과 캐릭터를 마치고 게임을 시작하세요.';

  if (input.turnStatus === 'action_waiting') {
    if (!input.myActionSubmitted) return '행동을 입력해 제출하면 턴이 진행됩니다.';
    if (input.pendingActionCount > 0) return `행동 제출 완료. 다른 플레이어 ${input.pendingActionCount}명 대기 중입니다.`;
    return '모든 행동이 제출되어 판정 단계로 넘어갑니다.';
  }

  if (input.turnStatus === 'roll_waiting') {
    if (input.myPendingChecks > 0) return `판정 ${input.myPendingChecks}건이 남았습니다. d20을 굴려 제출하세요.`;
    if (input.pendingRollCount > 0) return `다른 플레이어의 주사위 ${input.pendingRollCount}건 대기 중입니다.`;
    return '모든 주사위 제출이 완료되었습니다.';
  }

  if (input.turnStatus === 'resolving') return '결과를 계산하고 있습니다.';
  if (input.turnStatus === 'next_scene') return '결과를 반영해 다음 장면을 생성하고 있습니다.';
  return '진행 상태를 동기화하는 중입니다.';
}

function parseResultLog(content: string): ParsedResultLog | null {
  try {
    const parsed = JSON.parse(content) as Partial<ParsedResultLog> & { result?: unknown };
    const normalizedOutcome =
      parsed.outcome === 'failed' || parsed.outcome === 'partial' || parsed.outcome === 'success'
        ? parsed.outcome
        : parsed.result === 'failed' || parsed.result === 'partial' || parsed.result === 'success'
          ? parsed.result
          : null;
    if (
      typeof parsed.actionText === 'string' &&
      typeof parsed.d20 === 'number' &&
      typeof parsed.total === 'number' &&
      normalizedOutcome
    ) {
      return {
        actionText: parsed.actionText,
        d20: parsed.d20,
        total: parsed.total,
        outcome: normalizedOutcome,
        preRollNarrative: typeof parsed.preRollNarrative === 'string' ? parsed.preRollNarrative : undefined,
        consequence: typeof parsed.consequence === 'string' ? parsed.consequence : undefined,
      };
    }
  } catch {
    // old plain-text format fallback
  }

  const matched = content.match(/^(.*)\s=>\sd20:(\d+),\stotal:(\d+),\s(failed|partial|success)$/);
  if (!matched) return null;
  return {
    actionText: matched[1]?.trim() ?? '',
    d20: Number(matched[2]),
    total: Number(matched[3]),
    outcome: matched[4] as ParsedResultLog['outcome'],
  };
}

function FlowStep(props: { label: string; active: boolean; done: boolean }) {
  const className = props.active
    ? 'border-[color:var(--ok)] bg-[#ecf5df] text-[color:var(--ok)]'
    : props.done
      ? 'border-[color:var(--line)] bg-[#f6f1e7] text-[color:var(--ink)]'
      : 'border-[color:var(--line)] bg-[#fffaf0] text-[color:var(--ink-2)]';
  return <div className={`rounded-lg border px-2 py-1 text-xs ${className}`}>{props.label}</div>;
}

function buildCharacterForm(character: RoomSnapshot['players'][number]['character'] | null): CharacterFormState {
  return {
    name: character?.name ?? 'Adventurer',
    role: character?.role ?? 'Adventurer',
    hp: String(character?.maxHp ?? 12),
    mp: String(character?.maxMp ?? 6),
    stats: {
      strength: String(character?.stats.strength ?? 10),
      dexterity: String(character?.stats.dexterity ?? 10),
      intelligence: String(character?.stats.intelligence ?? 10),
      charisma: String(character?.stats.charisma ?? 10),
      constitution: String(character?.stats.constitution ?? 10),
      wisdom: String(character?.stats.wisdom ?? 10),
    },
    skills: {
      persuasion: String(character?.skills.persuasion ?? 0),
      stealth: String(character?.skills.stealth ?? 0),
      investigation: String(character?.skills.investigation ?? 0),
    },
  };
}

function toBoundedInt(raw: string, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  return Math.min(max, Math.max(min, rounded));
}

function renderLogContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed.sceneDescription === 'string') {
      const summary = typeof parsed.summary === 'string' ? parsed.summary : '장면';
      return `${summary}\n${parsed.sceneDescription}`;
    }
    if (
      typeof parsed.actionText === 'string' &&
      typeof parsed.d20 === 'number' &&
      typeof parsed.total === 'number' &&
      typeof parsed.result === 'string'
    ) {
      const outcome = parsed.result === 'success' ? '성공' : parsed.result === 'partial' ? '부분 성공' : '실패';
      const lines = [
        `${parsed.actionText}`,
        `d20 ${parsed.d20} / 총합 ${parsed.total} / 결과 ${outcome}`,
      ];
      if (typeof parsed.preRollNarrative === 'string') lines.push(`상황: ${parsed.preRollNarrative}`);
      if (typeof parsed.consequence === 'string') lines.push(`결과: ${parsed.consequence}`);
      return lines.join('\n');
    }
    if (
      typeof parsed.playerName === 'string' &&
      typeof parsed.actionText === 'string' &&
      typeof parsed.dc === 'number' &&
      typeof parsed.preRollNarrative === 'string'
    ) {
      return [
        `${parsed.playerName}: ${parsed.actionText}`,
        `판정: ${String(parsed.checkType ?? 'ability')} ${String(parsed.skill ?? 'no-skill')} vs DC ${parsed.dc}`,
        `상황: ${parsed.preRollNarrative}`,
        `성공 시: ${String(parsed.successOutcome ?? '')}`,
        `부분 성공 시: ${String(parsed.partialOutcome ?? '')}`,
        `실패 시: ${String(parsed.failureOutcome ?? '')}`,
      ]
        .filter(Boolean)
        .join('\n');
    }
    return content;
  } catch {
    return content;
  }
}

function toMainSceneDescription(raw: string | null | undefined): string {
  if (!raw) return '장면 정보를 불러오는 중입니다.';

  const normalized = raw.replace(/\s+/g, ' ').trim();
  const withoutBackstory = normalized
    .replace(/직전 상황:\s*/g, '')
    .replace(/[^\s]*의 행동\(".*?"\)은\s*(성공|부분 성공|실패)로 이어졌다\.?\s*/g, '')
    .replace(/이제 장면은 다음 반응 단계로 넘어갑니다\.?\s*/g, '')
    .replace(/선택에 따라 위협이나 기회가 더 선명해집니다\.?\s*/g, '')
    .trim();

  const sentenceCandidates = withoutBackstory
    .split(/(?<=[.!?])\s+|(?<=다\.)\s+/)
    .map((item) => item.trim())
    .filter(Boolean);

  const concise = sentenceCandidates.slice(0, 3).join(' ').trim();
  return concise || withoutBackstory || normalized;
}

function parseCheckReason(reason: string): ParsedCheckReason {
  const fallback: ParsedCheckReason = {
    reason,
    preRollNarrative: reason,
    successOutcome: '행동이 성공적으로 진행됩니다.',
    partialOutcome: '부분적으로 성공하지만 대가가 남습니다.',
    failureOutcome: '뚜렷한 진전이 없습니다.',
  };

  try {
    const parsed = JSON.parse(reason) as Partial<ParsedCheckReason>;
    return {
      reason: typeof parsed.reason === 'string' ? parsed.reason : fallback.reason,
      preRollNarrative:
        typeof parsed.preRollNarrative === 'string'
          ? parsed.preRollNarrative
          : typeof parsed.reason === 'string'
            ? parsed.reason
            : fallback.preRollNarrative,
      successOutcome: typeof parsed.successOutcome === 'string' ? parsed.successOutcome : fallback.successOutcome,
      partialOutcome: typeof parsed.partialOutcome === 'string' ? parsed.partialOutcome : fallback.partialOutcome,
      failureOutcome: typeof parsed.failureOutcome === 'string' ? parsed.failureOutcome : fallback.failureOutcome,
    };
  } catch {
    return fallback;
  }
}

function rollD20(): number {
  const pool = new Uint32Array(1);
  globalThis.crypto.getRandomValues(pool);
  return (pool[0] % 20) + 1;
}
