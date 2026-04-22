# Chronicle Forge MVP (LLM Multiplayer TRPG)

온라인 보드게임 스타일 TRPG MVP입니다.
핵심 흐름: `방 생성/코드 입장 -> 게임 시작 -> 행동 제출 -> 인앱 d20 굴림 -> 서버 판정 -> LLM 장면 생성`.

## Tech Stack
- Frontend: Next.js 16, React 19, TypeScript(strict), Tailwind CSS v4
- Backend: Next.js Route Handlers + Custom Node Server (`server.ts`)
- Realtime: Socket.IO
- DB: SQLite + Prisma
- LLM: OpenAI API (`.env`의 `OPENAI_API_KEY`)
- Test: Vitest

## Quick Start
1. Install
```bash
npm install
```

2. Environment
```bash
cp .env.example .env
```

3. DB schema sync (MVP)
```bash
npm run db:generate
npm run db:push
```

4. Run
```bash
npm run dev
```

5. Open
- Lobby: `http://localhost:3000`

## Deploy on Render (no local server required)
1. Push this repository to GitHub.
2. In Render, create a **Blueprint** and select this repo (`render.yaml` is included).
3. Set `OPENAI_API_KEY` in Render environment variables.
4. Deploy. Render will run:
```bash
npm ci && npm run db:generate && npm run build
npm run db:push && npm run start
```
5. Share the Render URL with friends and test multiplayer directly over the internet.

### Notes for Render
- Free tier에서는 persistent disk를 붙일 수 없어 `DATABASE_URL=file:./dev.db`(ephemeral)로 동작합니다.
- 따라서 Free tier에서는 재시작/재배포 시 방/로그 데이터가 초기화될 수 있습니다.
- 데이터 영속이 필요하면 유료 플랜(디스크) 또는 PostgreSQL로 전환하세요.
- This MVP is designed for a single instance (Socket.IO + in-memory presence).
- If you scale to multiple instances later, move to PostgreSQL + Redis adapter.

## UX Behavior (updated)
- 게임 **시작 전**:
  - 진행 패널(Scene/행동/로그)은 숨김
  - 방 설정/캐릭터 설정 중심의 준비 화면 제공
- 게임 **시작 후**:
  - 방 설정/캐릭터 설정은 서버/클라 모두 잠금
  - 진행 상황 + 행동 입력 + 로그가 메인
  - 설정은 우측 구석 요약 카드로만 표시

## LLM Mode (server default)
- 모델은 UI 드롭다운에서만 선택됩니다(허용 목록: `NEXT_PUBLIC_ALLOWED_LLM_MODELS`).
- API 키는 서버 환경변수(`OPENAI_API_KEY`)만 사용합니다.
- 개인 키 입력 UI는 제거되었습니다.

## Room Code Join
- 각 방은 `roomCode`를 가짐 (예: `AB12CD`)
- 로비에서 코드로 직접 입장 가능
- API: `POST /api/rooms/join-by-code`

## Presence & Empty Room Handling
- 웹을 닫거나 네트워크가 끊겨도 서버가 주기적으로 소켓 세션과 DB `connected` 상태를 동기화합니다.
- 모든 플레이어가 나간 빈 방은 유예시간 후 자동으로 `finished` 처리됩니다.
- 기본값:
  - `PRESENCE_RECONCILE_INTERVAL_MS=30000`
  - `EMPTY_ROOM_GRACE_MS=180000`

## Dice Mode
- `manual_input`: 인앱 굴림(플레이어가 사이트에서 d20 버튼 클릭)
- `server_auto`: 서버 자동 굴림

## Important Files
- `render.yaml`: Render blueprint (build/start/env/disk)
- `app/page.tsx`: 로비(방 생성/방 코드 입장/공개방 목록)
- `app/room/[id]/page.tsx`: 준비 단계/게임 단계 분리 UI + 인앱 d20 굴림
- `app/api/rooms/route.ts`: 방 목록/생성 + 모델 검증 + roomCode 노출
- `app/api/rooms/join-by-code/route.ts`: 방 코드 입장 API
- `lib/room-code.ts`: roomCode 변환/정규화
- `lib/game-engine.ts`: 서버 권위 상태/잠금 규칙
- `server/socket.ts`: 소켓 이벤트 라우팅
- `lib/rules.ts`: 판정 계산
- `lib/llm.ts`: LLM JSON 응답 처리

## Socket Events
### Client -> Server
- `room:join`, `room:leave`, `room:sync`
- `room:config:update`
- `character:update`
- `game:start`, `game:end`
- `action:submit`, `roll:submit`

### Server -> Client
- `room:update`
- `turn:scene`
- `check:requested`
- `turn:resolve`
- `game:log`
- `game:end`
- `server:error`

## Automated Tests
### Run once
```bash
npm run test
```

### Watch mode
```bash
npm run test:watch
```

### Covered now
- `lib/rules.test.ts`
  - modifier/d20 validation/판정 경계
- `lib/llm.test.ts`
  - 서버 API 키 미설정 시 LLM 호출 반려 동작

## Manual Multiplayer Test Checklist
1. 터미널에서 `npm run dev` 실행
2. 브라우저 2개 세션으로 로비 접속
3. 세션 A에서 방 생성
4. 세션 B는 방 코드(`roomCode`)로 입장
5. 시작 전 화면에서 캐릭터 설정/방 설정 확인
6. 세션 A(호스트)에서 게임 시작
7. 설정 패널이 잠기고 진행 패널이 메인으로 전환되는지 확인
8. 양쪽에서 행동 제출
9. 판정 요청 시 `d20 굴리기` 버튼으로 제출
10. 턴 로그(action/check/result/scene)가 누적되는지 확인

## Environment Variables
`.env.example` 참고:
- `DATABASE_URL`
- `OPENAI_API_KEY`
- `NEXT_PUBLIC_ALLOWED_LLM_MODELS`
- `NEXT_PUBLIC_DEFAULT_MODEL`
- `PORT`
- `HOSTNAME`
- `NEXT_PUBLIC_API_URL`
- `PRESENCE_RECONCILE_INTERVAL_MS`
- `EMPTY_ROOM_GRACE_MS`

## Notes
- 서버 API 키가 없거나 LLM JSON 응답이 유효하지 않으면 해당 턴 진행은 에러로 반려됩니다.
- 기본 더미 시나리오: `금지된 성당의 그림자`

## LLM Health Check
- `GET /api/llm/health`
- 선택 쿼리: `?model=gpt-5.4`
- 서버의 `OPENAI_API_KEY`와 모델 연결 상태를 JSON으로 확인할 수 있습니다.
