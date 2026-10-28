# DSH Web Gateway V2 adapter

Registers provider `deepseek-web-v2` and connects DSH to the original AI Gateway core. v0.4.0 auto-discovers the local Gateway, preferring `127.0.0.1:1601` and falling back to `127.0.0.1:8787`.

Features:
- keeps the logged-in DeepSeek web identity; no DeepSeek API key is required;
- serializes DSH system/history/tool schemas into the web relay prompt;
- reads durable DSH images and projected local file handles;
- marks latest-user attachments as `current`: ordinary sends upload only current attachments, while historical attachment bytes are carried/cacheable for an automatic rollover;
- converts OpenAI-compatible SSE back into DSH stream blocks;
- retains strict pseudo-tool-call compatibility as a fallback;
- pairs with the patched Gateway V2 APK whose page bridge performs real file-input upload and automatic new-chat rollover.

Limits are intentionally conservative: 16 MiB per attachment, 20 MiB raw attachment bytes total per request. The patched APK accepts a 32 MiB HTTP request body so base64/JSON overhead still fits.

After installation select provider `deepseek-web-v2` and model `deepseek-chat`. Existing `dsh-web-relay-toolcall-compat` may remain installed; it is redundant for this provider but native tool-call streams pass through unchanged.

Important: static tests cannot prove that DeepSeek's live webpage still exposes compatible upload/new-chat controls. Run the supplied QA preset on a real device before treating the release as runtime PASS.


## v0.3.0 tool-protocol recovery

The provider now owns first-line recovery for DeepSeek Web textual tool envelopes before DSH assembles the assistant message.

- Recognizes legacy Chinese pseudo calls, tagged JSON `<tool_calls>[...]</tool_calls>`, hybrid tagged JSON with residual DSML closing tags, and canonical/degraded DSML.
- Keeps reasoning chunks while buffering candidate tool protocol, so reasoning-before-tool-call responses no longer bypass compatibility handling.
- Preserves valid calls in partial batches; unavailable calls are reported through `web_relay_compat_feedback` when that tool is present.
- A truly malformed whole envelope becomes terminal failure code `WEB_TOOL_PROTOCOL_MALFORMED` rather than leaked assistant markup.
- The provider retry policy includes `WEB_TOOL_PROTOCOL_MALFORMED`; the shipped Web composition's `dsh-llm-retry` can therefore re-run the failed model step in the same turn without persisting malformed partial output.
- Bounded retry policy remains normal mode with five retries and the standard transient codes plus the new malformed-tool-protocol code.


## v0.3.1 native-tool loop stabilization

This release fixes a post-tool-result failure mode observed on Android DSH where valid tools executed, but the next model step repeatedly emitted malformed textual tool protocol and exhausted retries with `PI_AI_ERROR`.

Changes:

- Provider-native tool/function calls are now the only model-facing tool protocol when tools are available.
- The prompt no longer contains literal legacy, tagged-JSON, DSML, XML, or other textual tool-call examples.
- Historical assistant tool-call blocks are used only to map call IDs to tool names; they are no longer serialized back into prompt text.
- Tool results remain visible to the next model step, including ordinary execution failures such as EACCES or command-not-found.
- Internal `web_relay_compat_feedback` remains registered for the compatibility layer but is hidden from the upstream model's provider tool list.
- Malformed textual protocol retry budget is reduced from five retries to two; the fallback parser remains enabled.
- A failed tool result is not itself treated as a malformed model response.

Recommended pair:
- dsh-web-gateway-v2 0.3.1
- dsh-web-relay-toolcall-compat 0.8.0


## v0.4.0 original-core integration

This release changes the integration boundary rather than rewriting the working AI Gateway.

### Local transport

The adapter now probes, in order:

1. `http://127.0.0.1:1601/v1/chat/completions` — original AI Gateway;
2. `http://127.0.0.1:8787/v1/chat/completions` — compatibility fallback.

The selected endpoint is cached briefly and re-probed after transport/path failures.

If no API key is configured and the selected endpoint is loopback, the provider sends a non-empty local compatibility credential automatically. This satisfies clients/gateways that require an API-key field without exposing a public credential.

### Models

The same DSH provider now exposes the original Gateway model ids:

- `deepseek-chat`
- `chatgpt-web`
- `grok-web-fast`
- `glm-web-flash`

The original Gateway remains responsible for the actual webpage/provider selection and page automation.

### Do not randomly stop active replies

The DSH request AbortSignal is no longer wired directly to the local Gateway socket.

A generic disconnect such as `client_disconnected`, UI replacement, or transient client loss does **not** immediately tear down a live webpage generation. If the DSH consumer disappears without an explicit user-cancel reason, the provider drains the Gateway SSE response in the background so the original Gateway can finish normally.

Only a clearly identified user stop/cancel is allowed to abort immediately. Detached draining and the request itself remain bounded by a hard timeout; this is not an infinite background task.

Conversation-limit rollover is separate: silence, long reasoning, temporary no-token periods, or network jitter must never be interpreted as evidence that a new conversation is required.

See `ORIGINAL_GATEWAY_COMPAT.md` for the frozen-core hashes and integration contract.

Recommended pair:
- dsh-web-gateway-v2 0.4.0
- dsh-web-relay-toolcall-compat 0.8.0
