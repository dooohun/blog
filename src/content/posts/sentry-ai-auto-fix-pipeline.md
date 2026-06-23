---
title: "Sentry 에러를 AI가 자동으로 수정하는 파이프라인 설계하기"
meta_title: ""
description: "Sentry 에러 발생부터 Claude Code의 자동 분석과 PR 생성까지 이어지는 파이프라인을, 왜 이런 구조를 선택했는지 각 설계 결정의 배경에 집중해 정리한 기록."
date: 2026-06-19T09:00:00Z
image: "/images/posts/sentry-claude.png"
categories: ["학습"]
tags: ["Sentry", "Claude Code", "Webhook", "자동화"]
draft: false
---

서비스를 운영하다 보면 Sentry 알림을 받고, 코드를 열고, 스택트레이스를 보고, 원인을 파악하고, 수정하고, PR을 올리는 과정을 반복하게 된다. 이 흐름 자체는 단순하지만 반복적이다. Claude Code가 이 과정을 대신할 수 있지 않을까? 라는 생각으로 설계를 해보았다.

이 글은 **Sentry 에러 발생 → 자동 분석 → PR 생성**까지 이어지는 파이프라인을 설계하고 구축한 경험을 다룬다. 구현 세부사항보다는 **왜 이런 구조를 선택했는지**, 각 설계 결정의 과정을 다루고 있다.

### 기존 흐름: Sentry 알림 → Slack → 사람이 수동으로 수정

자동화를 떠올린 건 결국 기존 흐름이 불편했기 때문이다. 원래 대응 과정은 이랬다.

stage 환경에서 프론트엔드 에러가 발생하면 Sentry가 이를 잡아내고, Alert 연동을 통해 Slack 채널(`#코인_오류_front_end_stage`)로 알림을 보낸다. 채널에는 `ReferenceError`, `TypeError` 같은 에러들이 시간순으로 쌓인다.

![Slack 채널에 쌓인 Sentry stage 에러 알림](https://velog.velcdn.com/images/ehgns0305/post/74d261cc-8bd9-40c6-86fd-796ecd67c18f/image.png)

여기까지는 자동이다. 문제는 그다음부터다. 개발자는 Slack 알림을 보고 → Sentry 이슈 페이지로 들어가 → 스택트레이스와 브레드크럼을 읽고 → 원인이 될 만한 소스 파일을 찾고 → 수정하고 → PR을 올린다.

![Sentry 이슈 상세 페이지 — 스택트레이스와 컨텍스트](https://velog.velcdn.com/images/ehgns0305/post/6e9578a7-3818-41d4-a786-75b9a3ccbfbf/image.png)

위 이슈(`ReferenceError: dtrum is not defined`)처럼, 한 건을 처리하려면 Sentry 화면에서 스택트레이스(`app:///gtm.js:739:429` …), 발생 URL, 환경, 브레드크럼을 일일이 눈으로 훑어야 한다. 흐름 자체는 단순하지만 **알림을 받는 일만 자동이고, 그 뒤의 분석과 수정은 전부 사람 몫**이다. 그래서 stage처럼 에러가 자주 쌓이는 환경에서는 알림은 빠르게 차오르는데 대응은 계속 밀린다.

이 "Slack 알림 이후의 반복 노동"을 누가 대신할 수 있을까? 그게 이 파이프라인의 출발점이었다. Sentry가 Slack까지 보내주듯, 그 알림을 사람 대신 **Claude Code가 받아서 분석하고 PR까지 만들면** 되지 않을까 생각이 들었다.

### 시작 - 복잡한 설계

처음에는 이런 구조로 시작했다.

```markdown
Sentry → Vercel (webhook receiver) → GitHub repository_dispatch → GitHub Actions → Oracle Instance → PR
```

각 단계가 생겨난 데는 나름의 이유가 있었다.

**Vercel이 webhook receiver가 된 이유.** Sentry는 webhook을 보낼 public HTTPS endpoint가 필요하다. 가장 빠른 선택은 Vercel이었다. 배포만 하면 자동으로 HTTPS가 붙고, 서버 관리가 필요 없다. Oracle 인스턴스에 직접 포트를 열고 SSL을 설정하는 것보다 훨씬 빠르게 시작할 수 있었다.

**GitHub Actions가 끼어든 이유.** Vercel이 webhook을 받고 나서 Oracle을 직접 호출하려면 Oracle에도 public endpoint가 있어야 한다. 하지만 Oracle 인스턴스는 외부에 노출돼 있지 않았다. 이 문제를 해결하는 방법으로 **역방향 연결** 패턴을 선택했다. Vercel이 GitHub에 `repository_dispatch` 이벤트를 발행하면, Oracle의 GitHub Actions runner가 GitHub를 polling하다가 이벤트를 감지해서 실행하는 구조다.

```
Vercel ──→ GitHub (이벤트 발행)
                  ↑
Oracle ────────── GitHub Actions runner가 polling
```

Oracle이 외부에 노출되지 않아도, GitHub를 중계 채널로 써서 트리거를 받을 수 있었다. 각 단계는 나름의 이유로 추가됐지만, 결과적으로 아무런 비즈니스 로직 없이 데이터를 전달하기만 하는 단계들이 쌓였다.

### 최종: Oracle 인스턴스 하나로 줄이기

불필요한 중간 단계를 제거하면 답은 명확했다.

```
Sentry → Oracle Instance → PR
```

Oracle 인스턴스가 webhook을 직접 받아서 Claude Code를 실행하면 된다. Vercel도, GitHub Actions도 필요 없다.

이 구조가 가능한 이유는 단순하다. Claude Code CLI는 결국 로컬(혹은 서버)에서 실행되는 프로세스다. 굳이 GitHub Actions라는 CI 환경을 거칠 이유가 없었다. webhook을 받는 주체와 Claude Code를 실행하는 주체를 하나로 합치자, 중계만 하던 단계들이 통째로 사라졌다.

### 설계 결정 1: Oracle 인스턴스에 직접 public endpoint 열기

Sentry가 webhook을 보내려면 공개적으로 접근 가능한 HTTPS endpoint가 필요하다. 방법은 두 가지였다.

**Option A: Oracle 인스턴스에 직접 HTTPS 열기**

- nginx + Let's Encrypt SSL
- Oracle Security List와 OS 방화벽(nftables)에서 443 포트 오픈
- SSL 갱신, 포트 관리 등 직접 운영

**Option B: Cloudflare Tunnel**

- 인스턴스에서 `cloudflared` 데몬 하나만 실행
- 포트 오픈, SSL 설정 불필요
- Cloudflare 의존성 추가

**A를 선택한 이유.** 외부 서비스 의존성을 추가하지 않으면서 직접 제어할 수 있는 구조가 더 낫다고 판단했다. SSL 갱신은 certbot이 자동으로 처리해주기 때문에 실제 운영 부담은 크지 않다.

### 설계 결정 2: webhook을 어디까지 믿을 것인가

public endpoint를 열었다는 것은, 그 주소를 아는 누구나 POST 요청을 보낼 수 있다는 뜻이다. 이 요청 하나가 곧바로 Claude Code 프로세스를 띄우고 git push까지 이어지기 때문에, 입력을 검증하는 단계가 생각보다 중요했다.

**시크릿을 두 경로로 받기.** Sentry의 webhook은 강력한 서명(HMAC) 검증을 강제하지 않는다. 그래서 공유 시크릿 방식을 택했는데, 이걸 헤더(`x-webhook-secret`)와 쿼리 파라미터(`?secret=...`) **두 경로 모두**에서 받도록 했다. Sentry의 Alert 연동 UI는 버전과 연동 방식에 따라 커스텀 헤더를 못 넣는 경우가 있어서, 헤더가 막히면 URL에 시크릿을 붙이는 쪽으로 우회할 수 있게 한 것이다. 둘 중 하나라도 일치하지 않으면 `401`을 반환한다.

**body 읽기에 타임아웃 걸기.** 요청 본문을 읽는 단계에 `Promise.race`로 8초 타임아웃을 걸었다. 외부에 열린 endpoint이다 보니, 느리거나 중간에 끊긴 연결이 핸들러를 무한정 붙잡고 있을 수 있다. 8초를 넘기면 `408`로 끊어내고 다음 요청을 받을 수 있게 했다.

이렇게 검증 단계를 실패 사유별로 다른 상태 코드(`401` 인증 실패, `408` 수신 지연, `400` JSON 파싱 실패)로 나눠두면, Sentry 쪽 전송 로그만 봐도 어디서 막혔는지 바로 구분된다.

### 설계 결정 3: Webhook 수신 즉시 응답하기 (fire-and-forget)

Sentry는 webhook을 보낸 후 응답을 일정 시간 안에 받지 못하면 실패로 처리한다. Claude Code가 코드를 분석하고 PR을 만들기까지는 수분이 걸릴 수 있다. 이 두 가지는 양립하기 어렵다.

해결책은 **fire-and-forget** 패턴이다.

```
Sentry webhook 수신
  ↓
payload 파싱 및 검증
  ↓
Claude Code를 백그라운드 프로세스로 spawn (detached)
  ↓
즉시 200 응답 반환  ← Sentry는 여기서 완료로 처리
  ↓ (비동기)
Claude가 백그라운드에서 분석 → 수정 → PR 생성
```

Node.js에서는 `child_process.spawn`에 `detached: true`와 `proc.unref()`를 조합하면 부모 프로세스와 완전히 분리된 백그라운드 프로세스를 만들 수 있다. 핵심은 핸들러 안에서 `runClaudeCode(issue, aiContext)`를 **`await` 없이** 호출한다는 점이다. spawn만 던져두고 곧장 응답으로 넘어가므로, Claude Code가 몇 분을 돌든 HTTP 응답은 그와 무관하게 즉시 반환된다.

**응답에 무엇을 담을 것인가.** 즉시 반환하는 `200` 응답은 "잘 받았다"는 신호 이상의 역할을 하기 어렵다. 그래도 디버깅에 도움이 되도록, 응답 body에 처리에 필요한 최소한의 메타데이터를 실어 보낸다.

- `issueId` / `eventId` — 어떤 이슈를 받았는지
- 스택트레이스 프레임 개수 — 컨텍스트가 비어 있지 않은지
- 브레드크럼 존재 여부, `top_in_app_frame` 추출 성공 여부

이렇게 해두면 PR이 만들어지기 한참 전이라도, Sentry 전송 로그에 찍힌 응답만으로 "컨텍스트가 제대로 구성됐는지"를 즉시 확인할 수 있다. 정작 결과물(PR)은 비동기로 만들어지므로, 동기 응답이 줄 수 있는 정보를 최대한 끌어모은 셈이다.

트레이드오프는 있다. Sentry 입장에서는 PR이 실제로 만들어졌는지 알 수 없고, Claude Code 실패 여부도 별도로 모니터링해야 한다. 하지만 "일단 받고 처리한다"는 단순함이 더 중요했다.

### 설계 결정 4: AI에게 전달할 컨텍스트 설계

Claude Code가 에러를 제대로 분석하려면 Sentry의 raw payload를 그대로 넘기는 것보다 구조화된 컨텍스트를 만들어서 전달하는 것이 낫다.

이 변환을 한 번에 하지 않고 **두 단계**로 나눴다.

1. `normalizeSentryPayload()` — Sentry의 중첩된 payload에서 핵심 식별자(이슈 ID, 이벤트 ID, 제목, URL, 환경, 프로젝트)만 평평하게 뽑아낸다.
2. `buildAiContext()` — 정규화된 이슈와 원본 payload를 함께 받아, Claude에게 줄 `AiDebugContext`를 조립한다.

굳이 나눈 이유는, **식별자 추출**과 **분석용 컨텍스트 조립**의 성격이 다르기 때문이다. 식별자는 브랜치 이름(`fix/sentry-{issueId}`)이나 임시 파일 경로처럼 시스템이 쓰는 값이라 안정성이 중요하고, 컨텍스트는 Claude가 읽을 내용이라 풍부함이 중요하다. 둘을 한 함수에 섞으면 책임이 뒤엉킨다.

**ID는 반드시 문자열로.** 정규화 과정에서 가장 신경 쓴 부분이다. Sentry의 이슈/이벤트 ID는 큰 정수라서, 그대로 두면 후속 단계(특히 셸/CI 환경)에서 `1.23e+15` 같은 지수 표기로 변질될 수 있다. ID가 변질되면 브랜치 이름도, 임시 파일 경로도 어긋난다. 그래서 ID는 추출 시점에 명시적으로 문자열로 변환한다.

**누락에 대비한 fallback chain.** webhook payload는 환경과 SDK 버전에 따라 필드가 들쭉날쭉하다. 그래서 핵심 필드마다 우선순위 사슬을 뒀다.

- 제목: `issue.title → event.title → event.message → 기본값`
- 프로젝트 슬러그: `webhook 슬러그 → event 슬러그 → 프로젝트 이름 → 환경 변수 → 숫자 ID`

어느 한 경로가 비어도 다음 경로로 넘어가므로, 필드 하나가 없다고 파이프라인 전체가 멈추지 않는다.

이렇게 정리한 정보를 `AiDebugContext` 스키마로 묶는다.

```
AiDebugContext {
  issue: { id, title, url, level, environment, project }
  event: { id, message, culprit, transaction, timestamp }
  stacktrace: {
    frames: [...],          // 최근 20개 프레임
    top_in_app_frame        // 가장 관련성 높은 in-app 프레임
  }
  breadcrumbs: {
    last_items: [...]       // 최근 20개 브레드크럼
  }
  runtime: { browser, os, device, url, user_agent }
  tags: { ... }
  ai_instructions: {        // Claude에게 직접 전달하는 지시사항
    goal, constraints, expected_output
  }
}
```

**스택트레이스 처리.** Sentry의 frames 배열은 오래된 것부터 최근 순으로 정렬된다. 최근 20개만 유지하고, `in_app: true`인 프레임 중 마지막 것을 `top_in_app_frame`으로 추출한다. Claude가 node_modules나 프레임워크 내부보다 실제 앱 코드에 집중하도록 유도하기 위해서다.

**민감정보 마스킹.** 브레드크럼의 `data` 필드에는 요청 헤더, 쿠키, 토큰이 포함될 수 있다. key 이름 기반으로 민감한 필드를 `[REDACTED]`로 치환한다.

### 설계 결정 5: Claude Code CLI 호출 방식

Claude Code CLI를 서버에서 프로그래매틱하게 실행할 때 고려한 것들.

**프롬프트 전달.** `--print` 모드에서 긴 프롬프트는 stdin으로 전달하는 것이 안정적이다.

```typescript
const proc = spawn(
  "claude",
  [
    "--print",
    "--dangerously-skip-permissions",
    "--allowedTools",
    "Bash,Read,Edit,Write",
  ],
  { cwd: REPO_PATH, detached: true, stdio: ["pipe", "pipe", "pipe"] },
);

proc.stdin.write(prompt);
proc.stdin.end();
```

**working directory.** Claude가 `REPO_PATH`(대상 레포)를 cwd로 실행되어야 파일 탐색과 수정이 올바르게 동작한다.

**허용 도구.** `Bash`(git 명령어, gh CLI), `Read`(파일 읽기), `Edit`/`Write`(코드 수정). 이 4가지면 분석 → 수정 → 커밋 → PR 생성 전체가 가능하다. 권한 프롬프트가 끼어들면 백그라운드 프로세스가 멈춰버리므로 `--dangerously-skip-permissions`로 비대화형 실행을 보장하되, 그만큼 허용 도구를 위 4가지로 좁혀 위험 범위를 제한했다.

**프롬프트는 절차로 적는다.** Claude에게 주는 프롬프트는 추상적인 목표("이 에러 고쳐줘") 대신, 따라야 할 절차를 순서대로 적었다.

1. `@/tmp/sentry-{issueId}.json`의 스택트레이스와 브레드크럼을 분석한다
2. 관련 소스 파일을 찾아 수정한다
3. `fix/sentry-{issueId}` 브랜치를 만든다
4. 커밋하고 푸시한다
5. `gh`로 PR을 생성한다

컨텍스트 파일을 프롬프트에 직접 붙이지 않고 `@경로` 참조로 넘기는 이유는, payload가 크면 프롬프트가 비대해지고, Claude가 파일을 직접 `Read`하게 두는 편이 토큰 측면에서도 깔끔하기 때문이다.

**프로세스의 뒷정리.** spawn한 프로세스의 `close` 이벤트에서 두 가지를 한다. 하나는 `/tmp/sentry-{issueId}.json` 임시 파일 삭제(실패하더라도 try-catch로 흘려보낸다), 다른 하나는 stdout/stderr와 종료 코드 로깅이다. 다만 Claude의 출력은 길어질 수 있어 로그는 500자로 잘라 남긴다. 백그라운드라 화면에 아무것도 안 뜨는 만큼, 나중에 "무슨 일이 있었는지" 추적할 최소한의 단서는 남겨두는 것이다.

### 설계 결정 6: 왜 PR까지만 만들고 멈추는가

파이프라인의 마지막 단계는 `gh pr create`다. 마음만 먹으면 `gh pr merge`까지 붙여서 "에러 발생 → 자동 수정 → 자동 배포"로 완전 무인화할 수도 있었다. 하지만 의도적으로 **PR 생성에서 멈추도록** 설계했다.

이유는 단순하다. AI의 수정은 틀릴 수 있다. 스택트레이스만 보고 증상을 가린 채 근본 원인을 놓칠 수도 있고, 엉뚱한 파일을 건드릴 수도 있다. 자동 merge까지 열어두면, 잘못된 수정이 아무 검토 없이 메인 브랜치로 들어가 또 다른 장애를 만든다.

그래서 이 시스템의 역할을 "**고치는 주체**"가 아니라 "**리뷰할 거리를 만들어두는 주체**"로 한정했다. Claude가 하는 일은 사람이 처음부터 해야 했을 일(에러를 분석하고, 원인을 추정하고, 수정안을 코드로 만들어 PR에 정리하는 것) 까지다. 그 PR을 받아들일지 말지는 사람이 결정한다. 반복적인 앞단을 자동화하되, **마지막 판단 게이트는 사람에게 남긴다**는 것이 이 설계의 핵심 안전장치다.

### 전체 흐름 정리

```
[Sentry] 에러 발생
    │
    │ POST /webhooks/sentry?secret=...
    ▼
[nginx] TLS termination
    │
    │ proxy_pass localhost:3000
    ▼
[Node.js - Hono]
    ├─ secret 검증
    ├─ payload 파싱
    ├─ AiDebugContext 빌드
    ├─ /tmp/sentry-{id}.json 저장
    └─ claude CLI spawn (background)
    │
    │ 즉시 200 응답
    ▼
[Sentry] 완료 처리

    (백그라운드)
    ▼
[Claude Code CLI]
    ├─ /tmp/sentry-{id}.json 분석
    ├─ KOIN_WEB_RECODE 탐색
    ├─ 코드 수정
    ├─ git checkout -b fix/sentry-{id}
    ├─ git commit & push
    └─ gh pr create
    ▼
[GitHub] PR 생성 완료
```

### 남은 과제: 실패와 중복을 어떻게 다룰 것인가

지금까지의 구조는 "에러 하나가 정상적으로 들어와서, Claude가 한 번에 잘 고치는" 행복한 경로를 가정한다. 하지만 실제 운영에서는 그렇지 않은 경우가 더 많다. 현재 설계가 아직 충분히 답하지 못하는 두 가지 문제가 있다.

**실패가 보이지 않는다.** fire-and-forget의 대가다. Claude가 중간에 죽거나, 수정이 엉뚱하거나, push 권한 문제로 PR 생성에 실패해도 그 사실이 어디에도 드러나지 않는다. 지금은 프로세스의 `close` 이벤트에서 종료 코드와 출력 일부를 로그로 남기는 정도가 전부라, 서버에 직접 들어가 로그를 봐야 한다. webhook을 즉시 끊어버린 대신, **결과를 되돌려 알릴 채널**이 사라진 셈이다. 자연스러운 다음 수순은 처리 결과(성공/실패, 생성된 PR 링크, 실패 사유)를 Slack이나 Sentry 이슈 코멘트로 다시 쏘는 것이다. 비동기로 일을 떠넘긴 만큼, 결과를 회수할 경로를 따로 만들어야 한다.

**같은 에러가 반복해서 들어온다.** Sentry는 동일한 이슈에 대해 alert을 여러 번 보낼 수 있다. 그런데 브랜치 이름은 `fix/sentry-{issueId}`로 이슈 ID에 고정돼 있다. 같은 이슈가 두 번 들어오면 두 번째 실행은 이미 존재하는 브랜치와 충돌하거나, 같은 내용의 PR을 중복으로 만들려다 깨진다. 결국 **멱등성(idempotency)** 문제다. "이 이슈는 이미 처리했는가"를 판단할 상태가 어디에도 없다. 처리한 이슈 ID를 기록해두고 중복 요청을 앞단에서 스킵하거나, 브랜치·PR의 존재 여부를 먼저 확인하는 가드가 필요하다.

여기에 더해, 장애 상황에서 알림이 한꺼번에 쏟아지면 Claude 프로세스가 무제한으로 spawn되는 동시성 문제도 같은 뿌리에서 나온다. 세 문제 모두 "**받은 요청에 상태를 부여하지 않았다**"는 한 지점으로 모인다. 지금 구조는 요청을 받는 즉시 잊어버리기 때문에, 신뢰성을 한 단계 끌어올리려면 결국 요청에 식별자와 상태(접수됨 / 처리 중 / 완료 / 실패)를 부여하는 최소한의 상태 저장소가 필요해진다.

### 에러 처리 다시 보기: 실패를 상태와 알림으로 바꾸기

위에서 남겨둔 과제를 실제로 손보면서, 이 서버의 에러 처리를 처음부터 다시 들여다봤다. 관점은 하나로 모였다. 이 서버는 **외부(Sentry) → 외부(Claude CLI, GitHub, Sentry API)를 잇는 중계자**라서, 내가 통제할 수 없는 입력과 통제할 수 없는 실패가 사방에 깔려 있다. 그래서 에러 처리를 "예외 잡기"가 아니라 **흐름의 각 단계마다 실패를 어디서 끊고, 어떤 상태로 남기고, 누구에게 알릴지**의 문제로 보기로 했다.

#### 1. 요청 처리 흐름을 단계별 "관문"으로 나누기

webhook 핸들러는 순서가 곧 방어선이다. 각 단계가 실패하면 그 단계에 맞는 HTTP 상태 코드로 즉시 끊는다.

```
POST /webhooks/sentry
  ├─ 1. 시크릿 검증         불일치 → 401
  ├─ 2. body 읽기(타임아웃)  초과  → 408
  ├─ 3. JSON 파싱           실패  → 400
  ├─ 4. issueId 추출        없음  → 400
  ├─ 5. 멱등성 체크         중복  → 200 (skipped)
  └─ 6. 처리 수락           → 200 (accepted)
```

핵심은 "잘못된 입력(4xx)"과 "내 잘못(5xx)"을 분리한 것이다. 시크릿 불일치, 깨진 JSON, issueId 누락은 전부 클라이언트 책임(4xx)이라 재시도해도 의미가 없다. Sentry가 불필요하게 재발송하지 않도록 명확히 거절한다.

#### 2. "body가 안 끝나는" 문제 — 타임아웃으로 멈춰버리는 현상 차단

가장 골치 아팠던 건 서버리스(Vercel) 환경에서 요청 body 읽기가 끝나지 않고 멈춰버리는 현상이었다. 이건 일반 try/catch로는 못 잡는다. 멈춘 Promise는 예외를 던지지 않기 때문이다. 그래서 `Promise.race`로 타임아웃을 강제로 씌웠다.

```typescript
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      ),
    ),
  ]);
}

raw = await withTimeout(c.req.text(), BODY_READ_TIMEOUT_MS, "body-read"); // 8초
```

"응답이 없는 실패"는 "에러를 던지는 실패"보다 위험하다. 타임아웃은 그 무응답을 다시 명시적 에러(`408`)로 바꿔주는 장치다.

#### 3. 멱등성 — 같은 에러로 PR을 두 번 만들지 않기

앞서 과제로 남겼던 멱등성 문제를 여기서 푼다. Sentry webhook은 재시도되거나 중복 발송될 수 있다. 그대로 두면 하나의 에러에 PR이 여러 개 생긴다. 그래서 `issueId` 기준으로 처리 상태를 파일에 기록하고, 이미 `processing`/`completed`면 건너뛴다.

```typescript
const existing = processedStore.get(issue.issueId);
if (existing?.status === "processing" || existing?.status === "completed") {
  return c.json({ ok: true, status: "skipped", ... }); // 중복은 정상 응답으로 흡수
}
```

상태는 `processing → completed | failed` 세 가지로 관리한다. 주목할 두 가지 디테일이 있다.

- **원자적 쓰기.** 임시 파일에 쓴 뒤 `rename`으로 교체해서, 쓰는 도중 죽어도 스토어가 깨지지 않는다.
- **쓰기 직렬화.** 동시 요청이 같은 파일을 덮어쓰지 않도록 `writeChain` Promise로 순차 처리한다.

```typescript
const tmp = `${path}.tmp`;
writeFileSync(tmp, JSON.stringify(store, null, 2));
renameSync(tmp, path); // 원자적 교체
```

#### 4. 비동기 백그라운드 작업 — 응답은 먼저, 실패는 따로 알림

Claude Code 실행은 수 분이 걸린다. webhook 응답을 그때까지 붙잡고 있으면 Sentry 쪽이 타임아웃된다. 그래서 응답을 먼저 `202 accepted` 성격으로 돌려주고, 실제 작업은 detached 프로세스로 분리했다(앞서 설명한 fire-and-forget).

```typescript
await processedStore.markProcessing(issue.issueId);
runClaudeCode(issue, aiContext); // await 하지 않음 — fire and forget
return c.json({ ok: true, accepted: true, issueId: issue.issueId, ... });
```

여기서 문제는 "응답을 이미 보낸 뒤의 실패는 어떻게 알리나"이다. HTTP로는 못 알린다. 그래서 결과를 두 곳(상태 저장소 + Sentry 코멘트)에 남긴다.

```typescript
proc.on("close", (code) => {
  if (code === 0) {
    processedStore.markCompleted(issueId, prUrl);
    postIssueComment(issueId, `🤖 수정 PR을 생성했습니다: ${prUrl}`);
  } else {
    processedStore.markFailed(issueId, `exit code ${code}`);
    postIssueComment(issueId, `⚠️ 자동 수정에 실패했습니다 (exit ${code}).`);
  }
});
```

성공/실패가 Sentry 이슈 코멘트로 다시 돌아가서, 개발자가 원래 보던 화면에서 결과를 확인한다. 앞 섹션에서 "결과를 회수할 경로가 없다"고 적었던 빈자리가 이걸로 메워졌다. 백그라운드 작업의 에러 처리는 "로그를 남기는 것"이 아니라 "사람에게 닿게 하는 것"이 핵심이다.

#### 5. 알림 자체가 실패해도 본체는 안 죽는다

마지막 방어선. Sentry 코멘트 API 호출이 실패하더라도 그건 부가 기능이라 전체를 무너뜨리면 안 된다. 그래서 알림은 전부 "삼키는(swallow)" 에러 처리로 감쌌다.

```typescript
if (!env.SENTRY_API_TOKEN) {
  logger.warn("토큰 없음, 코멘트 스킵");
  return; // 토큰 없어도 throw 안 함
}
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    logger.warn(...);
    return;
  }
} catch (err) {
  logger.warn("Failed to post Sentry comment", ...); // 실패해도 warn만
}
```

`AbortSignal.timeout(10_000)`으로 외부 API 호출에도 타임아웃을 걸어, 느린 외부 의존성이 백그라운드 프로세스를 잡아두지 못하게 했다.

#### 정리 — 에러 처리 5가지 원칙

이번 작업에서 일관되게 적용한 원칙을 추리면 다섯 가지다.

1. **단계마다 끊어라** — 실패 지점에 맞는 상태 코드로 즉시 거절 (4xx vs 5xx 분리)
2. **무응답도 에러다** — hang은 타임아웃으로 명시적 에러로 변환 (`Promise.race`, `AbortSignal.timeout`)
3. **중복을 흡수하라** — 멱등성으로 재시도/중복 발송을 안전하게 무시
4. **응답 이후의 실패는 다른 채널로 알려라** — HTTP 대신 Sentry 코멘트로 결과 회신
5. **부가 기능 실패가 본체를 죽이면 안 된다** — 알림은 swallow + 로깅

> 한 줄 요약: 중계 서버의 에러 처리는 예외를 잡는 게 아니라, **통제 불가능한 외부 실패를 통제 가능한 상태와 알림으로 바꾸는 일**이다.

이렇게 해서 앞에서 남겨둔 세 과제(실패 가시성, 멱등성, 동시성)가운데 앞의 둘은 상태 저장소와 코멘트 회신으로 메워졌다. 동시성 제어(같은 이슈에 대한 프로세스 spawn 상한)는 멱등성 체크가 1차 방어선 역할을 하지만, 서로 다른 이슈가 한꺼번에 쏟아지는 경우의 큐잉은 아직 더 다듬을 여지가 남아 있다.

### 마치며

이 파이프라인의 핵심은 화려한 기술이 아니라, **불필요한 중간 단계를 걷어내는 것**이었다. 처음엔 Vercel과 GitHub Actions를 거치는 5단계 구조였지만, "누가 webhook을 받고 누가 Claude를 실행하는가"를 다시 묻자 Oracle 하나로 충분하다는 답이 나왔다. 나머지 설계 결정들(직접 HTTPS, fire-and-forget, 구조화된 컨텍스트, CLI 호출 방식)은 모두 그 단순한 골격 위에서 각자의 트레이드오프를 따져 내린 선택이다.

> 코드는 [dooohun/koin-sentry-webhook](https://github.com/dooohun/koin-sentry-webhook)에서 확인할 수 있다.
