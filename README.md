# acp-extension-grok

Lody's ACP compatibility adapter for the official Grok runtime.

The adapter does not contain, build, patch, or publish Grok. It launches the
official runtime supplied through `GROK_PATH` and translates the small private
wire contract pinned in `runtime-manifest.json` into standard ACP session
configuration options.

Supported configuration:

- Initial permission mode from `_meta.lody.sessionConfig` maps to Grok's
  startup `_meta.yoloMode` before `session/new` or restore reaches the official
  runtime, with `_meta.autoMode=false`. Later changes map to
  `x.ai/yolo_mode_changed` with the current Lody `clientIdentifier`, which is
  registered during ACP initialization. In Always Approve (YOLO), the adapter
  answers native `session/request_permission` requests directly: prefer
  `allow_once`, then `allow_always` if no single-use allow option exists. These
  requests are not forwarded to the client, preventing approval UI flicker.
  The latter option may persist a grant in the official runtime. Questions,
  mode-switch decisions, requests for unknown sessions, and requests without a usable allow option
  remain interactive.
- Reasoning effort maps to `session/set_model`, preserving the current model and
  setting `_meta.reasoningEffort`.
- Model and interaction mode map to the corresponding standard legacy ACP calls.
  Grok 1.0.13 reliably supports Agent and Plan. It silently ignores Ask, so the
  adapter does not advertise Ask and maps legacy persisted Ask selections to
  Plan.
- Per-turn token and trusted cost totals from Grok's prompt metadata or durable
  `_x.ai/session/update` `turn_completed` event map to Core's
  `_lody/session/usage_update` extension. Per-prompt model rows are accumulated
  across the ACP accounting lifetime and emitted with already-included deltas.
  Repeated prompt IDs can complete earlier partial statistics without being
  counted twice. Reports without IDs/model rows cannot be safely attributed.
  Core 0.1.5 must be published before this adapter release. Cache and reasoning totals are
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

Only Ask and Always Approve are advertised. Retired Auto selections in startup
metadata restore as Ask; live attempts to select Auto are rejected. Permission
changes still use an unacknowledged native notification, so the returned config
snapshot represents the adapter's accepted policy, not a runtime acknowledgement.
The fallback applies to incoming requests; requests already forwarded to a client
remain owned by that client. Standard elicitation requests pass through unchanged.

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
