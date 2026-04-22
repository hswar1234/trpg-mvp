export const ABILITIES = [
  'strength',
  'dexterity',
  'intelligence',
  'charisma',
  'constitution',
  'wisdom',
] as const;

export type Ability = (typeof ABILITIES)[number];
export type EntityType = 'object' | 'npc' | 'enemy' | 'location';
export type TurnMode = 'simultaneous' | 'sequential';
export type RollMode = 'manual_input' | 'server_auto';
export type TurnStatus = 'action_waiting' | 'roll_waiting' | 'resolving' | 'next_scene';
export type GameStatus = 'waiting' | 'in_progress' | 'finished';
export type ResolutionResult = 'failed' | 'partial' | 'success';

export interface RoomCreateInput {
  roomName: string;
  scenarioTheme: string;
  llmModel: string;
  ruleset: string;
  maxPlayers: number;
  isPrivate: boolean;
  password?: string;
  turnMode: TurnMode;
  statGenerationMode: 'standard_array' | 'balanced' | 'heroic';
  rollMode: RollMode;
  hostUserId: string;
  hostNickname: string;
}

export interface CharacterStats {
  strength: number;
  dexterity: number;
  intelligence: number;
  charisma: number;
  constitution: number;
  wisdom: number;
}

export interface CharacterSummary {
  id: string;
  name: string;
  role: string;
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  stats: CharacterStats;
  skills: Record<string, number>;
}

export interface PlayerSummary {
  roomPlayerId: string;
  userId: string;
  nickname: string;
  isHost: boolean;
  connected: boolean;
  isReady: boolean;
  hasSubmittedAction: boolean;
  hasSubmittedRoll: boolean;
  pendingChecks: number;
  character: CharacterSummary | null;
}

export interface ScenePayload {
  summary: string;
  sceneDescription: string;
  choicesHint: string[];
  importantEntities: Array<{
    name: string;
    type: EntityType;
  }>;
}

export interface ActionView {
  id: string;
  roomPlayerId: string;
  actionText: string;
  submittedAt: string;
}

export interface CheckView {
  id: string;
  roomPlayerId: string;
  actionId: string;
  checkType: Ability;
  skill: string | null;
  diceType: string;
  dc: number;
  reason: string;
  rollResult: number | null;
  resolved: boolean;
}

export interface ResolutionView {
  id: string;
  checkId: string;
  roomPlayerId: string;
  result: ResolutionResult;
  finalValue: number;
  statModifier: number;
  skillBonus: number;
  dc: number;
  actionText: string;
}

export interface GameLogView {
  id: string;
  logType: 'system' | 'scene' | 'action' | 'check' | 'result' | 'narrative';
  turnNumber: number;
  content: string;
  createdAt: string;
}

export interface RoomSnapshot {
  room: {
    id: string;
    roomCode: string;
    name: string;
    scenarioTheme: string;
    llmModel: string;
    ruleset: string;
    maxPlayers: number;
    isPrivate: boolean;
    turnMode: TurnMode;
    rollMode: RollMode;
    statGenerationMode: string;
    gameStatus: GameStatus;
    hostUserId: string;
    currentTurnId: string | null;
  };
  session: {
    id: string;
    sceneNumber: number;
    narrative: string;
  } | null;
  currentTurn: {
    id: string;
    turnNumber: number;
    status: TurnStatus;
  } | null;
  scene: ScenePayload | null;
  players: PlayerSummary[];
  actions: ActionView[];
  checks: CheckView[];
  resolutions: ResolutionView[];
  pendingActionPlayerIds: string[];
  pendingRollPlayerIds: string[];
  logs: GameLogView[];
}

export interface SceneGenerationInput {
  scenarioTheme: string;
  currentTurn: number;
  lastSceneDescription?: string;
  actions: Array<{
    playerName: string;
    actionText: string;
  }>;
  results: Array<{
    playerName: string;
    actionText: string;
    result: ResolutionResult;
  }>;
}

export interface ActionPlanningInput {
  scenarioTheme: string;
  currentScene: string;
  ruleset: string;
  actions: Array<{
    playerId: string;
    playerName: string;
    actionText: string;
    characterStats: CharacterStats;
    skills: Record<string, number>;
  }>;
}

export interface ActionPlanItem {
  playerId: string;
  actionText: string;
  checkRequired: boolean;
  checkType: Ability;
  skill: string | null;
  dice: 'd20';
  dc: number;
  reason: string;
  preRollNarrative: string;
  successOutcome: string;
  partialOutcome: string;
  failureOutcome: string;
}

export interface ActionPlanningOutput {
  resolutions: ActionPlanItem[];
}

export interface JoinRoomPayload {
  roomId: string;
  userId: string;
  nickname: string;
  password?: string;
}

export interface SocketAck<T = undefined> {
  ok: boolean;
  error?: string;
  data?: T;
}

export interface TurnResolvePayload {
  turnId: string;
  turnNumber: number;
  resolutions: ResolutionView[];
}

export interface ServerToClientEvents {
  'room:update': (snapshot: RoomSnapshot) => void;
  'turn:scene': (payload: { turnId: string; turnNumber: number; scene: ScenePayload }) => void;
  'check:requested': (payload: { turnId: string; checks: CheckView[] }) => void;
  'turn:resolve': (payload: TurnResolvePayload) => void;
  'game:log': (log: GameLogView) => void;
  'game:end': (payload: { roomId: string; reason: string }) => void;
  'server:error': (payload: { message: string }) => void;
}

export interface ClientToServerEvents {
  'room:join': (payload: JoinRoomPayload, ack: (result: SocketAck<{ roomPlayerId: string; snapshot: RoomSnapshot }>) => void) => void;
  'room:leave': (payload: { roomId: string }, ack: (result: SocketAck) => void) => void;
  'room:sync': (payload: { roomId: string }, ack: (result: SocketAck<RoomSnapshot>) => void) => void;
  'room:config:update': (
    payload: {
      roomId: string;
      turnMode?: TurnMode;
      rollMode?: RollMode;
      llmModel?: string;
    },
    ack: (result: SocketAck<RoomSnapshot>) => void
  ) => void;
  'game:start': (payload: { roomId: string }, ack: (result: SocketAck) => void) => void;
  'game:end': (payload: { roomId: string }, ack: (result: SocketAck) => void) => void;
  'character:update': (
    payload: {
      roomId: string;
      name: string;
      role: string;
      hp: number;
      mp: number;
      stats: CharacterStats;
      skills: Record<string, number>;
    },
    ack: (result: SocketAck<RoomSnapshot>) => void
  ) => void;
  'player:ready': (
    payload: { roomId: string; ready: boolean },
    ack: (result: SocketAck<RoomSnapshot>) => void
  ) => void;
  'action:submit': (payload: { roomId: string; actionText: string }, ack: (result: SocketAck) => void) => void;
  'roll:submit': (payload: { roomId: string; checkId: string; diceResult: number }, ack: (result: SocketAck) => void) => void;
}
