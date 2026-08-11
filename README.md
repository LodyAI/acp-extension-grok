# acp-extension-grok

Lody's ACP compatibility adapter for the official Grok runtime.

The adapter does not contain, build, patch, or publish Grok. It launches the
official runtime supplied through `GROK_PATH` and translates the small private
wire contract pinned in `runtime-manifest.json` into standard ACP session
configuration options.

Supported configuration:

- Permission mode maps to `x.ai/yolo_mode_changed` with the current Lody
  `clientIdentifier`.
- Reasoning effort maps to `session/set_model`, preserving the current model and
  setting `_meta.reasoningEffort`.
- Model and interaction mode map to the corresponding standard legacy ACP calls.
- Per-turn token and trusted cost totals from Grok's prompt metadata or durable
  `_x.ai/session/update` `turn_completed` event map to Lody's
  `acp_ext:session_usage_update` extension. Cache and reasoning totals are
  converted from Grok's inclusive counters into Lody's disjoint buckets.
- The adapter queries `x.ai/session/info` after session setup and completed
  prompts, then emits standard ACP `usage_update` context-window updates. Replay
  events never re-record historical billing usage.

The official 1.0.0 runtime does not expose an acknowledgement or a dependable
feature-gate signal for automatic permission mode. The mapping is covered by
contract tests, but the option remains hidden until a pinned official runtime
can advertise that capability.

Run with:

```sh
GROK_PATH=/path/to/official/grok node src/index.js
```
