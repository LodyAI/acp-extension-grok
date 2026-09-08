# acp-extension-grok

Lody's ACP compatibility adapter for the official Grok runtime.

The adapter does not contain, build, patch, or publish Grok. It launches the
official runtime supplied through `GROK_PATH` and translates the small private
wire contract pinned in `runtime-manifest.json` into standard ACP session
configuration options.

Supported configuration:

- Initial permission mode from `_meta.lody.sessionConfig` maps to Grok's
  startup `_meta.yoloMode` and `_meta.autoMode` (both explicit, including false)
  before `session/new` or restore reaches the official
  runtime. Later changes map to `x.ai/yolo_mode_changed` with the current Lody
  `clientIdentifier`, which is registered during ACP initialization. Grok's
  native standard `session/request_permission` requests pass through unchanged.
  Like the official TUI, Lody answers tool permissions with `allow_once` while
  Always Approve is selected and drains waiting requests when it is enabled.
  Keeping that handling in Lody also resolves its durable history and waiting UI.
- Reasoning effort maps to `session/set_model`, preserving the current model and
  setting `_meta.reasoningEffort`.
- Model and interaction mode map to the corresponding standard legacy ACP calls.
  Grok 1.0.13 reliably supports Agent and Plan. It silently ignores Ask, so the
  adapter does not advertise Ask and maps legacy persisted Ask selections to
  Plan.
- Per-turn token and trusted cost totals from Grok's prompt metadata or durable
  `_x.ai/session/update` `turn_completed` event map to Core's
  `_lody/session/usage_update` extension. Cache and reasoning totals are
  converted from Grok's inclusive counters into Lody's disjoint buckets.
- The adapter queries `x.ai/session/info` after session setup and completed
  prompts, then emits standard ACP `usage_update` context-window updates. Replay
  events never re-record historical billing usage.
- The adapter queries `x.ai/billing` after session setup and completed prompts,
  then maps the official credit usage percentage and billing period to Core's
  `_lody/rate_limits/update` extension. Clients can also call
  `_lody/rate_limits/get` independently of a session. For the fresh
  unified-billing shape where Grok explicitly returns zero cap, usage, and balance
  but omits the percentage, the adapter mirrors the official `/usage` UI's weekly `0%`.
  Billing failures never fail a session.

Automatic permission mode is exposed as an experimental option. The official
1.0.13 runtime accepts the private `auto_mode` notification but does not
acknowledge it, so the adapter applies the selection optimistically.

Run with:

```sh
GROK_PATH=/path/to/official/grok node src/index.js
```

## Plan configuration

Core’s boolean `plan_mode` option replaces the interaction-mode picker. The adapter maps it to the native default/plan session mode independently of `permission_mode`.

## Plan review

The native `x.ai/exit_plan_mode` reverse request is translated to standard ACP
`plan_update` (when advertised) and a `session/request_permission` decision with
`kind: switch_mode`. Older clients receive the plan in the approval tool's text
content. Empty plans still require a decision. Approve, keep planning, and abandon
map to the native `approved`, `cancelled`, and `abandoned` outcomes.

When the client advertises form elicitation, keep planning opens an optional
`elicitation/create` feedback form using Core's `_meta.lody.elicitation` contract.
Dismissal, errors, and session cancellation never approve a plan. Native mode
updates refresh Core's boolean `plan_mode` config option. The adapter does not
change permission policy when reviewing a plan.

Hosts must keep `switch_mode` decisions interactive, including when their tool
permission policy is Always Approve. Release this adapter with that host change;
ordinary tool auto-approval is not consent to implement a plan.
