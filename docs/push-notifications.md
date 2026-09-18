# Push 알림 (#17) — outbox → Expo Push

## 흐름

```text
서버 트리거 (0016/0018)                 send-push (Edge, service role, cron 1분)        앱
 messages insert  ─ new_message ─┐      notification_events_dequeue(limit)        expo-notifications
 상호 yes 성립    ─ mutual_… ────┼─▶ notification_events(outbox) ─▶ buildPushBatch ─▶ Expo Push API ─▶ 기기
 recommendations ─ daily_… ─────┤      notification_events_mark / push_tokens_disable   알림 탭 → routeForNotificationData → 화면
 상호 좋아요      ─ match_created ┘
```

| 항목 | 위치 |
|---|---|
| 토큰 등록 | 앱 `lib/push.ts` `registerPushToken` → RPC `push_token_register` (홈 진입 시 1회 권한 요청, 거부하면 다시 묻지 않음) |
| 토큰 해제 | 로그아웃·탈퇴 전 `unregisterPushToken`(본인 행 delete), `delete-account` 가 service role 로 전부 삭제, 발송 실패(DeviceNotRegistered) 시 `enabled=false` |
| 설정 | `notification_preferences` (종류별 on/off, 행 없으면 모두 on) — 내 정보 화면 스위치 |
| outbox | `notification_events` kind: `new_message` · `mutual_meetup_interest` · `daily_recommendation`(하루 1건) · `match_created`. dedupe_key 로 중복 없음 |
| 발송기 | `supabase/functions/send-push` — `_shared/notifications/pushCore.ts`(순수 로직, selftest 19건) |
| 딥링크 | data `{kind, match_id?, conversation_id?}` → new_message → 채팅방, mutual → 만남 화면, match_created → 대화 목록, daily → 홈 |

## 잠금화면에 나가는 것

본문은 종류별 **고정 문구**뿐이다: "새 메시지가 도착했어요." / "만남에 대한 새 소식이 있어요. 앱에서 확인해 보세요." /
"오늘의 소개가 도착했어요." / "새로운 대화가 열렸어요. 첫 인사를 건네 보세요." — 메시지 원문·상대 닉네임·일방 의향·거절·피드백은
payload 에도 본문에도 없다. 같은 대화의 여러 메시지는 발송 주기 안에서 한 번만 울린다.

## 발송 규칙

- `notification_events_dequeue` 는 `for update skip locked` 로 잠가 발송기가 여러 개 돌아도 같은 이벤트를 두 번 보내지 않는다.
  60초 넘게 잠긴 행(크래시)은 다시 가져오고, 5회 넘게 실패한 행은 `skipped_reason='expired'` 로 닫는다.
- 발송하지 않고 닫는 경우: 토큰 없음(`no_token`) · 설정 off(`pref_off`) · 수신자 비활성(`recipient_inactive`) · 소개 무효(`recommendation_invalid`, 아래) · 6시간 넘은 이벤트.
- 차단 쌍의 new_message 는 애초에 insert 되지 않는다 (`can_chat_in`). 차단 이후 남은 미발송 이벤트가 있어도 매치 상태와 무관한 고정 문구라 상대 정보를 드러내지 않는다.
- Expo 티켓 `DeviceNotRegistered` → 토큰 비활성화, 다른 오류 → 재시도.
- 발송 실패·skip 은 소개 생성과 무관하다 — 새 소개를 만들지 않는다. 앱을 열면 소개는 그대로 보인다.

## 오늘의 소개 알림 — 생성 조건과 발송 시점 재확인 (#22/#17, 0034)

- **생성**: `recommendations` 에 `pending` 행이 insert 될 때만 (`recommendations_notify` 트리거, dedupe `recommendation:<user>:<KST 날짜>` → 하루 1건).
  앱 요청·배치(`daily-recommendation-batch`, KST 09:00~21:45 15분 간격 — `docs/matching-policy.md` 10절)·재시도 어느 경로든 같은 키라 중복이 없다.
  후보 부족 확인·신규 가입·후보 발견 자체는 이벤트를 만들지 않는다.
- **참조**: 이벤트의 `recommendation_id` 가 소개 행을 가리킨다. 발송 전에 그 소개가 만료되고 같은 날 새 pending 소개가 생기면 참조만 새 행으로 옮긴다 (이벤트는 여전히 1건).
  이미 발송된 뒤에는 바꾸지 않는다 (하루 1건 유지 — 두 번째 소개는 알리지 않는다).
- **발송 시점 재확인**: `notification_events_dequeue` 가 `recommendation_valid` 를 함께 준다 = 소개가 아직 `pending` 이고 상대가 active·온보딩·본인/얼굴/성인 인증이며 두 사람 사이에 차단이 없다.
  false 면 `buildPushBatch` 가 `recommendation_invalid` 로 닫는다 (만료·차단·제재·탈퇴·이미 확인). 0034 이전 이벤트(참조 없음)·다른 종류는 null → 기존대로.
- **밤 알림**: 배치는 KST 22:00~08:59 에 돌지 않으므로 배치가 만든 소개 알림은 밤에 울리지 않는다. 앱을 직접 열어 생성된 소개·메시지·매치 알림은 시간대와 무관하다 — 전체 조용한 시간대 정책은 별도 이슈.
- **보장 범위**: DB 이벤트 생성(하루 1건)은 트리거·unique 로 보장한다. 기기 수신은 Expo/APNs/FCM 에 달려 있고, 티켓 오류 재시도는 같은 이벤트를 다시 보낼 수 있다 — 외부 전달을 정확히 한 번이라고 주장하지 않는다.

## 설정 (실제 프로젝트)

1. `0018_push_notifications.sql` 적용 → `supabase functions deploy send-push` (production 은 `deploy-production.sh` allowlist 에 포함).
2. Expo 대시보드에서 Enhanced Security 를 켰다면 `supabase secrets set EXPO_ACCESS_TOKEN=...` (선택).
3. cron 등록 — `supabase/scripts/schedule-recommendation-cron.sql` 이 `send-push`(1분)·`daily-recommendation-batch`(15분)·정리 작업을 한 번에, 같은 이름은 교체하며 등록한다
   (pg_cron + pg_net, service role key 는 Vault 의 `service_role_key`). `send-push` 만 따로 등록하면:

   ```sql
   select cron.unschedule(jobid) from cron.job where jobname = 'send-push';   -- 있으면 교체
   select cron.schedule('send-push', '* * * * *', $$
     select net.http_post(
       url := 'https://<project-ref>.supabase.co/functions/v1/send-push',
       headers := jsonb_build_object('Content-Type', 'application/json',
                                     'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
       body := '{"limit": 200}'::jsonb,
       timeout_milliseconds := 30000);
   $$);
   select cron.schedule('notification-events-prune', '30 18 * * *', $$ select public.notification_events_prune(interval '30 days') $$);
   ```
4. 앱: `app.json` 에 `expo-notifications` 플러그인 추가됨. **EAS 프로젝트가 연결돼 있어야** (`extra.eas.projectId`, #18) 토큰이 발급된다 —
   없으면 `registerPushToken` 이 조용히 건너뛴다. Expo Go 에서는 원격 push 가 동작하지 않는다 (Development Build).
   iOS 는 APNs 키를 EAS 에 등록해야 한다 (Apple Developer 필요 — 로드맵상 베타 직전).

## 검증

- 순수 로직: `cd supabase/functions/_shared/notifications && node --experimental-strip-types selftest.ts` (`recommendation_valid=false` → `recommendation_invalid`, null/true → 발송 포함)
- DB(JWT 컨텍스트): `supabase/tests/push_tests.sql` — 토큰 본인 행만·타인 명의 insert 거부·같은 토큰 재로그인 시 이전 계정에서 이전·
  outbox 트리거(match_created 2건, daily_recommendation 하루 1건)·dequeue 잠금/재시도/expired·발송기 RPC 클라이언트 호출 불가
- DB(0034): `supabase/tests/recommendation_batch_tests.sql` 3절 — 후보 부족 실행은 이벤트 없음 · 저장 시 1건 · 발송 전 참조 이전 · 발송 후 불변 · 발송 시점 재확인(만료/제재/차단/확인) · KST 날짜별 1건.
  `recommendation_db_test.mjs` 9절 — 배치가 만든 소개 → 이벤트 1건 → dequeue `recommendation_valid` → 발송 실패·설정 off·토큰 없음은 소개 생성과 무관.
- **미실행**: 실기기 수신(Android 우선, iOS 는 Apple Developer 이후), 알림 탭 화면 이동, Expo Push API 실제 호출, EAS projectId 연결.
  이 항목이 끝나기 전에는 앱·문서에 "알림이 간다" 고 약속하지 않는다.

## 추가 kind — `beta_admitted` (#26)

운영자가 대기자를 cohort 에 입장시키면(`beta_admit_waitlist` / `beta_admit_user`) outbox 에 `beta_admitted` 1건(dedupe `beta:admitted:<uid>`)이 쌓인다.
본문은 고정 문구("모집이 열렸어요. 앱에서 이어서 시작해 보세요."), data 는 `kind` 만. 알림 설정 스위치가 없는 종류라 항상 발송된다 (탈퇴·정지 계정 제외).
앱은 탭하면 Gate(`/`)로 가서 입장 상태를 다시 읽고 온보딩으로 보낸다. 대기 화면에서 알림 권한을 켜야 토큰이 있다 (`docs/beta-cohorts.md`).
