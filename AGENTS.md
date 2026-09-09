# Grok ACP adapter guidelines

`CLAUDE.md` is a symlink to this file. The public Lody repository guidelines also apply.

## Per-model reasoning-effort ladders

- The reasoning-effort list is the SELECTED model's ladder, re-derived from that
  model's own `_meta.reasoningEfforts` / `_meta.reasoning_efforts` on every
  model change; a switch to a model that publishes no ladders withdraws the
  control rather than reusing another model's list, while a repeat for the
  same model keeps what the session already reported.
- Session responses publish the per-model view to Lody as
  `_meta.lody.modelReasoningEfforts`; vendor model `_meta` never reaches Lody
  as a contract.
- The runtime `model_changed` notification is translated to standard ACP
  `config_option_update`, never passed through to Lody.

## Permission modes

- Seed both `yoloMode` and `autoMode`, including explicit false, on new/load/resume/fork.
  Pre-session notifications cannot configure a session that does not exist yet.
- Live selections still use the client-scoped `x.ai/yolo_mode_changed` notification.
  Resolve new YOLO tool permissions in the adapter as described below; requests
  already forwarded to Lody remain owned by its durable permission flow.

## Model snapshot settling

- Official Grok 1.0.13 may return a provisional model roster from `session/new`, then emit
  `_x.ai/models/update` later. The update has no session id and is a process-level complete
  snapshot containing `currentModelId` and `availableModels`.
- The production adapter must settle a pending session response from that explicit snapshot
  signal. If the snapshot arrives first, reuse it for the response. If the response arrives
  first, defer it only until the signal or the bounded safety timeout; never use an unconditional
  sleep.
- After a session response is already visible, translate a new snapshot to standard ACP
  `config_option_update`. Do not expose the provider-specific notification to Lody business code.
- Tests must deterministically cover initial 4.5 followed by a complete 4.6 + 4.5 snapshot, the
  reverse ordering, and the bounded fallback. Do not depend on scheduler timing or a real runtime.
- This settling happens inside the existing ACP process. It must not add Streams/Flock
  subscriptions or change connection cardinality.

## Plan approval

- Translate native plan approval only inside the wrapper, using standard ACP plan,
  permission, and elicitation messages. Core owns the Plan toggle and elicitation
  metadata; do not add a provider RPC or vocabulary to Lody business code.
- Preserve the native request id and envelope. Only explicit approval may return
  `approved`; errors and cancellation stay in Plan. Mode updates must refresh the
  boolean config snapshot without changing permission policy.

## Permission fallback

- Advertise only Ask and Always Approve. Retired startup Auto restores as Ask;
  reject live Auto selections and explicitly disable native auto mode.
- For a known session in Always Approve, answer native permission requests in
  the adapter, preferring `allow_once` then `allow_always`; match ACP option kinds,
  never substrings in labels or ids. Only select an option supplied by the request.
- Do not forward an automatically answered request to the client. Keep questions,
  mode-switch decisions, unknown sessions, and requests without usable allow options interactive.
- Never consume a pending client request when a reverse request uses the same id.
