# DSH Web Gateway V2 adapter

Registers provider `deepseek-web-v2` and sends DSH requests to the local browser gateway at `127.0.0.1:1601`.

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
