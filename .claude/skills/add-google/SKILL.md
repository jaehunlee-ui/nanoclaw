---
name: add-google
description: Add Google Workspace (Gmail + Calendar) integration. Admin sets up OAuth app once, each user connects their own Google account in chat. Triggers on "add google", "google workspace", "gmail calendar 연동".
---

# Add Google Workspace Integration

Admin creates one GCP OAuth app. Each user connects their own Google account via DM — different users access different Gmail/Calendar.

## Phase 1: Pre-flight

### Check if already applied

```bash
grep -q 'google-mcp-stdio' container/agent-runner/src/index.ts && echo "FOUND" || echo "NOT_FOUND"
```

If `FOUND`, skip to Phase 3.

## Phase 2: Apply Code Changes

### 2.1: Create Google MCP server

Create `container/agent-runner/src/google-mcp-stdio.ts` — a stdio MCP server that:
- Handles OAuth flow (auth URL generation, code exchange)
- Reads per-group credentials from `/workspace/group/.google-credentials.json`
- Auto-refreshes expired tokens
- Provides Gmail tools: search, read, send, list labels
- Provides Calendar tools: list events, create, update, delete, list calendars

### 2.2: Wire into agent-runner

Edit `container/agent-runner/src/index.ts`:

1. Check for per-group Google credentials:
```typescript
const hasGoogleCredentials = fs.existsSync('/workspace/group/.google-credentials.json');
```

2. Add to `allowedTools`:
```typescript
...(hasGoogleCredentials || process.env.GOOGLE_CLIENT_ID ? ['mcp__google__*'] : []),
```

3. Add to `mcpServers`:
```typescript
...(hasGoogleCredentials || process.env.GOOGLE_CLIENT_ID ? {
  google: {
    command: 'node',
    args: [path.join(__dirname, 'google-mcp-stdio.js')],
    env: {
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
    },
  },
} : {}),
```

### 2.3: Pass OAuth credentials to containers

Edit `src/container-runner.ts` — pass `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from `.env` to containers via `-e` flags, using `readEnvFile()`.

### 2.4: Create container skill

Create `container/skills/connect-google/SKILL.md` — in-chat skill that guides users through:
1. Click auth URL → Google login → copy redirect URL → paste back
2. Agent extracts code, exchanges for tokens, saves per-group

### 2.5: Copy agent-runner to existing groups

```bash
for dir in data/sessions/*/agent-runner-src; do
  [ -d "$dir" ] && cp container/agent-runner/src/index.ts container/agent-runner/src/google-mcp-stdio.ts "$dir/"
done
```

### 2.6: Validate and rebuild

```bash
npm run build
./container/build.sh
```

## Phase 3: Setup (Admin — 1회)

### Create GCP OAuth App

> 1. https://console.cloud.google.com 접속
> 2. 프로젝트 생성 또는 선택
> 3. **API 및 서비스 > 라이브러리**:
>    - "Gmail API" 검색 → **사용 설정**
>    - "Google Calendar API" 검색 → **사용 설정**
>    - "Google Drive API" 검색 → **사용 설정**
> 4. **API 및 서비스 > OAuth 동의 화면**:
>    - User Type: **외부** (External) 선택
>    - 앱 이름, 이메일 입력
>    - 범위 추가: `gmail.modify`, `calendar`, `drive`
>    - 테스트 사용자 추가 (사용할 Google 계정들)
> 5. **API 및 서비스 > 사용자 인증 정보**:
>    - **+ 사용자 인증 정보 만들기 > OAuth 클라이언트 ID**
>    - 애플리케이션 유형: **데스크톱 앱**
>    - 이름: "NanoClaw"
> 6. **Client ID**와 **Client Secret** 복사

### Configure .env

```bash
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

### Restart

```bash
npm run build
pm2 restart nanoclaw
```

## Phase 4: User Flow

각 사용자가 DM에서:

> "구글 연결해줘"

→ 에이전트가 `/connect-google` 스킬 실행 → 인증 URL 전송 → 사용자 로그인 → 토큰 저장 → 완료

## Troubleshooting

### "이 앱은 확인되지 않았습니다" 경고

GCP 앱이 프로덕션 인증을 받지 않았기 때문. 테스트 사용자로 등록된 계정만 사용 가능. **고급 → 안전하지 않음으로 이동** 클릭.

### 테스트 사용자 제한 (100명)

프로덕션 인증을 받으려면 Google 검증 필요. 소규모 팀은 테스트 모드로 충분.

### Token refresh 실패

`/workspace/group/.google-credentials.json` 삭제 후 다시 `/connect-google`.

### Google MCP 도구 안 보임

1. `.env`에 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` 확인
2. agent-runner 소스 복사: Phase 2.5 참고
3. 컨테이너 리빌드: `./container/build.sh`
4. `pm2 restart nanoclaw`

## Removal

1. `container/agent-runner/src/google-mcp-stdio.ts` 삭제
2. `container/agent-runner/src/index.ts`에서 google MCP 관련 코드 제거
3. `src/container-runner.ts`에서 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` 전달 제거
4. `container/skills/connect-google/` 삭제
5. `.env`에서 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` 제거
6. `rm -r data/sessions/*/agent-runner-src 2>/dev/null || true`
7. `npm run build && ./container/build.sh && pm2 restart nanoclaw`
