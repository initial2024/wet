# Original AI Gateway ↔ Updated DSH integration contract

This file defines the compatibility boundary for the updated DSH provider.

## Frozen original Gateway baseline

The original AI Gateway is treated as the working functional core. DSH-side work must not reimplement its browser automation, GeckoView session, login state, composer logic, send logic, upload logic or floating-window behavior.

Audited baseline patch artifacts:

- `base2-no-truncate-patch.zip`
  - SHA-256: `f8a205f7172793af196ec2368e05e932e30de0575b4d9f69766925cbc815feff`
- `classes.dex`
  - SHA-256: `9ed048ebd701150ec1a051f41b5098a37b45334cf402711e39ca338aada9b4e5`
- `assets/ai_gateway_bridge/bridge.js`
  - SHA-256: `f828989d613d366e7894d2bc635a9fa834ec440dfd9d15e61750bf9eb97b4122`

The frozen baseline already carries the first bounded long-generation patch:
- chat timeout raised from the older 200-second limit to 600 seconds;
- DeepSeek generation-state grace: 5 seconds.

The paired OmniGate add-on build then raises only the three previously verified native chat timeout immediates from 600 seconds to 3600 seconds. DSH `wet` deliberately uses a slightly larger 3660-second transport/drain ceiling so the provider bridge does not terminate before the original Gateway's own hard timeout.

## DSH provider responsibilities

`dsh-web-gateway-v2` is the adapter boundary. It may:

- serialize DSH system/developer/user/assistant/tool history;
- project DSH image/file attachments into the Gateway envelope;
- expose the original Gateway model IDs:
  - `deepseek-chat`
  - `chatgpt-web`
  - `grok-web-fast`
  - `glm-web-flash`
- convert OpenAI-compatible SSE into DSH native stream blocks;
- preserve native tool calls and use `ck` as defensive fallback for textual/DSML tool protocol;
- auto-discover the local Gateway at:
  1. `127.0.0.1:1601` (original Gateway first);
  2. `127.0.0.1:8787` (compatibility fallback);
- automatically send a non-empty local compatibility API key when no explicit key is configured.

It must not replace the original Gateway's page-level input/send/upload implementation.

## Active-generation protection

A live webpage generation must not be cancelled merely because DSH changes UI state, replaces a client transport, briefly disconnects, or raises a generic AbortSignal.

Policy:

1. A clearly identified user stop/cancel may terminate the transport.
2. A generic disconnect such as `client_disconnected` is not treated as user cancellation.
3. When the DSH consumer disappears without an explicit user cancel, the provider drains the Gateway HTTP response in the background so the original Gateway does not immediately receive a socket disconnect.
4. Detached draining is bounded to 3660 seconds in the paired DSH provider; the original Gateway hard request timeout is 3600 seconds. This is intentionally finite.
5. Conversation rollover/new-chat is a separate mechanism and must only be triggered by explicit provider-side conversation/context-limit evidence. Silence, long reasoning, temporary no-token periods and network jitter are not rollover evidence.

## Add-on responsibilities

Other DSH repositories remain layered:

- `wet`: provider/transport/attachments/native stream bridge.
- `ck`: tool-call protocol recovery and admission.
- `webs`: controlled browser + human handoff.
- `jc`: read-only UI/status projection.
- `cs`: independent QA preset.

No add-on may silently weaken another layer's permission or tool-admission rules.

## Runtime acceptance

Static PASS is not runtime PASS.

A real Android acceptance must demonstrate at minimum:

1. DSH can connect when original Gateway port 1601 is available.
2. When 1601 is absent and the compatibility Gateway is on 8787, DSH reconnects through 8787.
3. All four model IDs are selectable and route to the expected provider.
4. Text, image and file requests preserve original Gateway behavior.
5. A generic DSH disconnect does not immediately stop an already-running webpage answer.
6. An explicit user stop still terminates within a bounded time.
7. A real provider context-limit event is the only condition that causes automatic new-chat continuation.
