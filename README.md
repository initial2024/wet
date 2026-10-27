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
