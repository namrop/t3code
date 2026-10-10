# Estate push v1 (build-only draft)

Implements Luis's Oasis Estate ruling `01a1134f` (2026-10-06): build phone delivery once for all estate apps; each app presents its own notifications, and the delivery transport stays replaceable. T3 Code (Sol) is the first consumer. This branch neither enables a service nor changes a phone.

## Five-line contract

1. Each app opts in and registers its app/device identity, opaque HTTPS endpoint and explicit event preferences using its existing paired credential.
2. A shared Sol service owns registration leases, bounded endpoint delivery, retry and restart-safe per-device deduplication; app adapters only produce events.
3. The sender posts a small versioned JSON envelope unchanged to an approved endpoint origin, without interpreting topic names or query strings.
4. On Android today ntfy holds the connection in UnifiedPush distributor mode, then the receiving app validates and displays its own notification.
5. Registration is not delivery or resolution; HTTP acceptance is not proof the phone displayed anything, and a later transport adapter must preserve these boundaries.

## Service choice and separation

Use separate `estate-push.service`, not a new subsystem inside T3's server. Python's standard library provides the generic SQLite store, registration API and HTTP outbox. `t3-estate-push-watch.service` is a thin read-only WebSocket adapter built from `infra/relay/scripts/estate-push-watch.ts`. Neither reads T3's live database. Watcher interruption cannot restart T3; T3 upgrade cannot erase estate registrations. Subsequent estate apps supply their own verifier URL and event adapter, not a second sender. No Firebase, Google or Apple account is involved. APNs is a later adapter, **not** claimed to be a plain HTTP URL with no other credentials.

The HTTPS registration surface is `https://t3.sol.pharos.zone/estate-push/v1/...`, an explicitly private Caddy path proxying the loopback sender. The source/ingestion surface `/v1/events` is loopback-only and deliberately not exposed through Caddy. This keeps the paired bearer on its existing Sol origin. A subsequent app gets an explicitly configured HTTPS registration route and its own credential verifier. Nothing is enabled merely by importing the fleet module.

## Registration wire format

`PUT /v1/apps/{app_id}/registrations/{device_id}` with `Authorization: Bearer <existing paired credential>`:

```json
{
  "app_id": "zone.pharos.t3code",
  "device_id": "installation-and-pair-specific-id",
  "endpoint": "https://ntfy.sol.pharos.zone/opaque-token?up=1",
  "preferences": { "approval": true, "input": true, "completed": true, "failed": true }
}
```

Preferences are explicit booleans keyed by app-defined event kinds (at most 32); absent kinds are OFF. T3 supplies all four booleans, not provider defaults. App/device identifiers are `[A-Za-z0-9_.:-]{1,128}`; route and body identity must agree. PUT is idempotent, returns `{registered:true,expires_at:<Unix seconds>}`; the app performs exact-target `GET` readback before reporting registered. `GET` returns `{registered:boolean,expires_at:number|null}`; `DELETE` returns `{removed:boolean}` and cancels pending delivery. Another paired owner cannot replace or remove the same app/device registration. Registration endpoints and paired credentials are never returned through the API or logged.

For T3 the verifier calls its existing `/api/auth/session` with the bearer, requires authenticated state and `orchestration:read` scope, and identifies the owner by SHA-256 of that session credential. An installation's registration identity changes when it is re-paired; otherwise a new session cannot overwrite an old owner's registration. The original device secret and session are never published. The server retains the bearer solely in its private mode-0700 state directory so it can **revalidate before each delivery**, not just when registering. Revoked/expired credentials disable delivery. Verifier outages retry, not authorize. The app's native duplicate is encrypted by Android Keystore AES/GCM; backup must exclude it. A 30-day registration lease renews on app foreground/settings reconciliation, does not override the credential's own expiry, and eventually expires orphaned installations. No sender registrations are preseeded.

## Event and push format

A trusted local adapter POSTs `/v1/events` with a separate operator-provisioned publisher bearer, not the phone credential:

```json
{
  "app_id": "zone.pharos.t3code",
  "event_id": "sha256-transition-id",
  "kind": "failed",
  "occurred_at": 1791331200,
  "title": "T3 Code (Sol)",
  "body": "The agent run failed.",
  "route": "/threads/environment-id/thread-id"
}
```

Response `{queued:<number>}` counts new device outbox rows, not shown notifications. The sender adds `version:1` and `device_id`. Title is bounded to 80 characters, body to 160, endpoint to 1000 UTF-8 bytes, API body to 4096 bytes. Time is Unix seconds; events older than ten minutes or more than one minute in the future are rejected. The private sender stores identifiers, bounded notification text and delivery state. T3 supplies the thread title, project, phase headline and available source detail; its shell projection does not contain actual result summaries or failure causes. Native presentation uses that bounded text with fixed event-label fallbacks for missing or malformed fields. It does not fetch prompts or transcripts. Deep links stay internal app routes, never external URLs.

T3 maps `waiting_for_approval`, `waiting_for_input`, `completed`, `failed` to `approval`, `input`, `completed`, `failed`. The title identifies the thread; the body identifies the project and event, with available source detail. Display labels are whitespace-normalized and shortened with an ellipsis when necessary. `starting`, `running`, `stale`, title-only changes and archived threads do not alert. The adapter's first snapshot silently establishes a baseline; persisted baselines can catch a recent transition during a reconnect. SQLite journals the phase change and ingest event together, then retries ingestion until its ten-minute expiry. Event identity is a stable hash of environment, thread, phase and transition timestamp. The generic sender uses `(app,device,event)` as the unique delivery key across restarts.

## Transport boundary and failure policy

Endpoints are opaque, including `?up=1`; the service checks **only** explicit approved HTTPS origins plus basic URL safety. It does not derive topics or rebuild URLs. No redirects, URL userinfo, fragments or unapproved origins; production never permits test-only loopback HTTP endpoints. ntfy's raw UnifiedPush compatibility mode expects `application/octet-stream` containing the JSON bytes. Include a remaining `TTL` header. ntfy's `?up=1` makes this a UnifiedPush message, not a notification in the ntfy app. Existing general ntfy topics such as `sol-alerts` are unrelated and unchanged.

HTTP 2xx marks server acceptance only. Network/verifier errors, 429 and 5xx retry with bounded 5/10/20/40/80/160/300-second backoff, at most eight attempts and no delivery after event expiry. 404/410 disable the dead registration; other responses reject that delivery. Endpoint replacement or preference removal cancels old queued delivery. A short SQLite transaction claims each request without holding the registration lock across HTTP; an already-claimed send may finish during opt-out. The app immediately gates each event by its current local preference as well as global opt-in. A restart recovers unfinished claims for retry. SQLite dedupe survives restart; completed rows retain seven days, expired event IDs cannot be replayed later. Native event IDs survive process restart (bounded last 256), with independent payload freshness checks. Process death between ntfy acceptance and SQLite acknowledgment can produce a duplicate; native dedupe suppresses it. This is at-least-once delivery within a bounded TTL, not an exactly-once or guaranteed-display promise.

No new Shofar escalation policy, quiet-hours policy or resolution tracking is invented here. Android's existing notification channel/permission and on-screen-thread suppression remain the presentation boundary. Disabling opts out locally immediately; remote removal is attempted and persisted for bounded retries/foreground reconciliation if offline. A remaining server lease is not described as successfully removed.

## Android integration / future operator checks

The small Expo native module talks to ntfy 1.25.2's raw-byte UnifiedPush `REGISTER`, `NEW_ENDPOINT`, `MESSAGE`, `UNREGISTERED`, `REGISTRATION_FAILED` broadcasts. A random UUID connection token authenticates callbacks. Package discovery explicitly prefers `io.heckel.ntfy` (or its F-Droid variant); no distributor means an honest unavailable state. Android 14+ broadcasts share caller identity; an immutable PendingIntent supports older ntfy SDK identity checks. The receiver works without JS being open, keeps NEW_ENDPOINT reconciliation alive for bounded HTTP PUT + GET, and reuses T3's existing native renderer/deep-link handling. It is not an encrypted WebPush AND_3.1 implementation.

A `sol-alerts` subscription and battery exemption **do not prove** UnifiedPush's default server is Sol. Future installation must confirm ntfy Settings → UnifiedPush enabled and default server `https://ntfy.sol.pharos.zone`; the connector rejects public-ntfy endpoints rather than leaking estate payloads there. The app defaults OFF, requests notification permission only on explicit enable, offers local settings without Clerk/cloud config, and renews/reconciles on foreground. Turning off permission remains a clear settings condition. Only an existing saved direct bearer connection to the exact Sol T3 HTTPS origin is eligible.

## Build and activation boundary

Fleet module: `modules/services/estate-push.nix`, option `pharos.services.estate-push.enable = false` by default. Sender package: `pkgs/estate-push/`. Watcher source: this repository. Future activation requires operator-provisioned publisher and read-only T3 session token files, a built watcher package, explicit service enablement, and a Sol switch. Enabling adds sender/watcher units and the private Caddy registration path; Caddy needs reload, T3 and ntfy need no restart. No token is minted or service changed during this build.

A new native APK is required; OTA JS alone cannot install a broadcast receiver. Build/sign with the existing Sol recipe and key; installation/phone settings remain a separate authorized task. Wireless debugging is relevant only if choosing ADB installation later; it is not required by the push design. No phone or emulator end-to-end result is claimed by unit tests.

## Sources

- [UnifiedPush Android connector guidance](https://unifiedpush.org/developers/android/)
- [UnifiedPush Android specification](https://unifiedpush.org/developers/spec/android/)
- [ntfy UnifiedPush configuration](https://docs.ntfy.sh/config/#unifiedpush)
- [ntfy Android 1.25.2 distributor implementation](https://github.com/binwiederhier/ntfy-android/blob/v1.25.2/app/src/main/java/io/heckel/ntfy/up/Distributor.kt)
- Existing T3 relay redaction: `infra/relay/src/agentActivity/FcmDeliveries.ts`; read-only subscription example: `infra/relay/scripts/android-push-watch.ts`; paired-session verifier: `apps/server/src/auth/http.ts`.
