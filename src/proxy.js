import runtimeManifest from '../runtime-manifest.json' with { type: 'json' };

const PERMISSION_MODES = {
  ask: { permission_mode: 'ask', yolo_mode: false, auto_mode: false },
  auto: { permission_mode: 'auto', yolo_mode: false, auto_mode: true },
  'always-approve': {
    permission_mode: 'always-approve',
    yolo_mode: true,
    auto_mode: false,
  },
};

// Grok 1.0.0 silently accepts `ask` without changing its runtime mode. Keep
// legacy persisted Ask selections safe by degrading them to Plan, but do not
// advertise Ask until the runtime reports and applies it.
const INTERACTION_TO_RUNTIME = { agent: 'default', plan: 'plan', ask: 'plan' };
const INTERACTION_FROM_RUNTIME = { default: 'agent', plan: 'plan', ask: 'plan' };
const USD_TICKS_PER_USD = 10_000_000_000;
const MAX_TRACKED_PROMPTS = 256;
const FIVE_HOUR_WINDOW_MINS = 5 * 60;
const SEVEN_DAY_WINDOW_MINS = 7 * 24 * 60;

function logicalExtensionMethod(method) {
  return typeof method === 'string' && method.startsWith('_') ? method.slice(1) : method;
}

function wireExtensionMethod(method) {
  return method.startsWith('_') ? method : `_${method}`;
}

function nonnegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function optionalNonnegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalAmount(value) {
  return optionalNonnegativeNumber(value?.val ?? value);
}

function billingUsagePercent(config, period, allowTopLevelFallback) {
  const explicit = optionalNonnegativeNumber(period.creditUsagePercent);
  if (explicit !== undefined) return explicit;
  if (allowTopLevelFallback && period !== config) {
    const topLevelExplicit = optionalNonnegativeNumber(config.creditUsagePercent);
    if (topLevelExplicit !== undefined) return topLevelExplicit;
  }

  const limit = optionalAmount(
    period.monthlyLimit ?? (allowTopLevelFallback ? config.monthlyLimit : undefined)
  );
  const used = optionalAmount(
    period.totalUsed ??
      period.includedUsed ??
      period.used ??
      (allowTopLevelFallback ? (config.totalUsed ?? config.used) : undefined)
  );
  if (limit && used !== undefined) return (used / limit) * 100;

  // Grok Build 1.0.0 omits creditUsagePercent for a fresh unified-billing
  // weekly period and reports each balance field as an explicit zero. Its own
  // `/usage` UI renders that exact response as "Weekly limit: 0%", so mirror
  // the official client only for this fully-zero, provider-authored shape.
  const hasOfficialZeroUsage =
    config.isUnifiedBillingUser === true &&
    config.currentPeriod?.type === 'USAGE_PERIOD_TYPE_WEEKLY' &&
    optionalAmount(config.onDemandCap) === 0 &&
    optionalAmount(config.onDemandUsed) === 0 &&
    optionalAmount(config.prepaidBalance) === 0;
  if (hasOfficialZeroUsage) return 0;

  return undefined;
}

function unavailableRateLimits(planName = null) {
  return {
    schemaVersion: 2,
    planName,
    limitName: 'Grok Build',
    limitId: 'grok',
    windows: [],
    fiveHour: null,
    sevenDay: null,
    fiveHourResetAt: null,
    sevenDayResetAt: null,
    apiUnavailable: true,
  };
}

function normalizeUsageModel(usage, usageIsIncomplete) {
  const inputTokens = nonnegativeNumber(usage?.inputTokens);
  const outputTokens = nonnegativeNumber(usage?.outputTokens);
  const cacheReadInputTokens = nonnegativeNumber(usage?.cachedReadTokens);
  const cacheCreationInputTokens = nonnegativeNumber(usage?.cacheCreationTokens);
  const reasoningOutputTokens = nonnegativeNumber(usage?.reasoningTokens);
  const costUsdTicks = usage?.costUsdTicks;
  const hasTrustworthyCost =
    !usageIsIncomplete &&
    usage?.costIsPartial !== true &&
    typeof costUsdTicks === 'number' &&
    Number.isFinite(costUsdTicks) &&
    costUsdTicks >= 0;

  return {
    // Grok's ACP totals include cache buckets in inputTokens and reasoning in
    // outputTokens. Lody stores disjoint buckets and adds them for reporting.
    inputTokens: Math.max(0, inputTokens - cacheReadInputTokens - cacheCreationInputTokens),
    outputTokens: Math.max(0, outputTokens - reasoningOutputTokens),
    cacheReadInputTokens,
    cacheCreationInputTokens,
    reasoningOutputTokens,
    ...(hasTrustworthyCost ? { costUSD: costUsdTicks / USD_TICKS_PER_USD } : {}),
  };
}

export function normalizePromptUsage(promptUsage) {
  if (!promptUsage || typeof promptUsage !== 'object') return undefined;
  const usageIsIncomplete = promptUsage.usageIsIncomplete === true;
  const usage = normalizeUsageModel(promptUsage, usageIsIncomplete);
  const modelUsage = {};
  if (promptUsage.modelUsage && typeof promptUsage.modelUsage === 'object') {
    for (const [modelId, model] of Object.entries(promptUsage.modelUsage)) {
      if (model && typeof model === 'object') {
        modelUsage[modelId] = normalizeUsageModel(model, usageIsIncomplete);
      }
    }
  }
  return {
    usage,
    ...(Object.keys(modelUsage).length ? { modelUsage } : {}),
  };
}

function usageNotification(promptUsage) {
  const params = normalizePromptUsage(promptUsage);
  if (!params) return undefined;
  return {
    jsonrpc: '2.0',
    method: wireExtensionMethod(runtimeManifest.privateWireContract.lodyUsageNotification),
    params,
  };
}

export function normalizeBillingRateLimits(billing) {
  if (!billing || typeof billing !== 'object') return undefined;
  const config = billing.config;
  if (!config || typeof config !== 'object') return undefined;

  const latestHistory = Array.isArray(config.history) ? config.history.at(-1) : undefined;
  const period = config.currentPeriod ?? latestHistory ?? config;
  const allowTopLevelFallback = period === config.currentPeriod || period === config;
  let usedPercent = billingUsagePercent(config, period, allowTopLevelFallback);
  if (usedPercent !== undefined) usedPercent = Math.min(100, usedPercent);

  const start = period?.start ?? period?.billingPeriodStart ?? config.billingPeriodStart;
  const end = period?.end ?? period?.billingPeriodEnd ?? config.billingPeriodEnd;
  const startMs = typeof start === 'string' ? Date.parse(start) : Number.NaN;
  const endMs = typeof end === 'string' ? Date.parse(end) : Number.NaN;
  const measuredWindowDurationMins =
    Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
      ? Math.round((endMs - startMs) / 60_000)
      : null;
  const windowDurationMins =
    period?.type === 'USAGE_PERIOD_TYPE_WEEKLY'
      ? SEVEN_DAY_WINDOW_MINS
      : measuredWindowDurationMins;
  const resetsAt = Number.isFinite(endMs) ? endMs : null;
  const isFiveHour = windowDurationMins === FIVE_HOUR_WINDOW_MINS;
  const isSevenDay = windowDurationMins === SEVEN_DAY_WINDOW_MINS;
  const tier = billing.subscriptionTier ?? billing.subscription_tier;
  const planName = typeof tier === 'string' && tier.trim() ? tier : null;

  if (usedPercent === undefined) {
    if (!planName && windowDurationMins === null && resetsAt === null) return undefined;
    return unavailableRateLimits(planName);
  }

  return {
    schemaVersion: 2,
    planName,
    limitName: 'Grok Build',
    limitId: 'grok',
    windows: [{ usedPercent, windowDurationMins, resetsAt }],
    fiveHour: isFiveHour ? usedPercent : null,
    sevenDay: isSevenDay ? usedPercent : null,
    fiveHourResetAt: isFiveHour ? resetsAt : null,
    sevenDayResetAt: isSevenDay ? resetsAt : null,
  };
}

function rateLimitsNotification(billing) {
  const params = normalizeBillingRateLimits(billing);
  if (!params) return undefined;
  return {
    jsonrpc: '2.0',
    method: wireExtensionMethod(runtimeManifest.privateWireContract.lodyRateLimitsNotification),
    params,
  };
}

function contextUsageNotification(sessionId, context) {
  const size = nonnegativeNumber(context?.total);
  const used = nonnegativeNumber(context?.used);
  if (size <= 0) return undefined;
  return {
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: { sessionUpdate: 'usage_update', size, used },
    },
  };
}

function unwrapExtensionResult(result) {
  if (!result || typeof result !== 'object') return result;
  return Object.prototype.hasOwnProperty.call(result, 'result') ? result.result : result;
}

function rememberPrompt(set, promptId) {
  if (!promptId || set.has(promptId)) return false;
  set.add(promptId);
  if (set.size > MAX_TRACKED_PROMPTS) {
    set.delete(set.values().next().value);
  }
  return true;
}

function errorResponse(id, message) {
  return { jsonrpc: '2.0', id, error: { code: -32602, message } };
}

function optionName(value) {
  if (value === 'xhigh') return 'X-High';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function legacyOptions(result) {
  const options = result?._meta?.[runtimeManifest.privateWireContract.sessionConfigMeta]?.options;
  return Array.isArray(options) ? options : [];
}

function readReasoningEfforts(model) {
  const raw = model?._meta?.reasoningEfforts ?? model?._meta?.reasoning_efforts;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => (typeof item === 'string' ? item : (item?.id ?? item?.reasoningEffort)))
    .filter((item) => typeof item === 'string');
}

function selectOption(id, name, description, currentValue, options, category) {
  return {
    id,
    name,
    description,
    category,
    type: 'select',
    currentValue,
    options,
  };
}

export function permissionNotification(clientIdentifier, mode) {
  const mapped = PERMISSION_MODES[mode];
  if (!mapped) return undefined;
  return {
    jsonrpc: '2.0',
    method: wireExtensionMethod(runtimeManifest.privateWireContract.permissionNotification),
    params: { clientIdentifier, ...mapped },
  };
}

export class GrokAcpCompatibilityProxy {
  constructor() {
    this.sessions = new Map();
    this.pending = new Map();
    this.nextInternalRequestId = Number.MAX_SAFE_INTEGER;
  }

  internalRequest(kind, sessionId) {
    while (this.pending.has(this.nextInternalRequestId)) this.nextInternalRequestId -= 1;
    const id = this.nextInternalRequestId;
    this.nextInternalRequestId -= 1;
    this.pending.set(id, { kind, sessionId });
    const isBilling = kind === 'billing';
    return {
      jsonrpc: '2.0',
      id,
      method: wireExtensionMethod(
        isBilling
          ? runtimeManifest.privateWireContract.billingRequest
          : runtimeManifest.privateWireContract.sessionInfoRequest
      ),
      params: isBilling ? {} : { sessionId },
    };
  }

  usageRefreshRequestsForPrompt(state, promptId) {
    if (promptId && !rememberPrompt(state.usageRefreshPromptIds, promptId)) return [];
    return [
      this.internalRequest('context', state.sessionId),
      this.internalRequest('billing', state.sessionId),
    ];
  }

  usageForPrompt(state, promptId, promptUsage) {
    const notification = usageNotification(promptUsage);
    if (!notification) return undefined;
    if (promptId && !rememberPrompt(state.usagePromptIds, promptId)) return undefined;
    return notification;
  }

  handleClient(message) {
    if (!message || typeof message !== 'object') return { toRuntime: [message], toClient: [] };
    const params = message.params ?? {};
    if (
      message.method === 'session/new' ||
      message.method === 'session/load' ||
      message.method === 'session/resume'
    ) {
      const clientIdentifier = params._meta?.clientIdentifier;
      if (message.id !== undefined) {
        this.pending.set(message.id, {
          kind: 'session',
          method: message.method,
          sessionId: params.sessionId,
          clientIdentifier,
        });
      }
      return { toRuntime: [message], toClient: [] };
    }
    if (message.method === 'session/prompt') {
      if (message.id !== undefined) {
        this.pending.set(message.id, {
          kind: 'prompt',
          sessionId: params.sessionId,
        });
      }
      return { toRuntime: [message], toClient: [] };
    }
    if (message.method !== 'session/set_config_option') {
      return { toRuntime: [message], toClient: [] };
    }

    const { sessionId, configId, value } = params;
    const state = this.sessions.get(sessionId);
    if (!state || typeof value !== 'string') {
      return {
        toRuntime: [],
        toClient: [errorResponse(message.id, 'Unknown Grok session or invalid config value')],
      };
    }

    if (configId === 'permission_mode') {
      if (value === 'auto' && !runtimeManifest.privateWireContract.autoPermissionMode) {
        return {
          toRuntime: [],
          toClient: [
            errorResponse(
              message.id,
              'Auto permission mode is unavailable in the pinned Grok runtime'
            ),
          ],
        };
      }
      const notification = permissionNotification(state.clientIdentifier, value);
      if (!notification || !state.clientIdentifier) {
        return {
          toRuntime: [],
          toClient: [
            errorResponse(
              message.id,
              'Grok permission mode requires the current Lody clientIdentifier'
            ),
          ],
        };
      }
      for (const trackedState of this.sessions.values()) {
        if (trackedState.clientIdentifier === state.clientIdentifier) {
          trackedState.permissionMode = value;
        }
      }
      return {
        toRuntime: [notification],
        toClient: [
          {
            jsonrpc: '2.0',
            id: message.id,
            result: { configOptions: this.configOptions(state) },
          },
        ],
      };
    }

    let translated;
    let effectiveValue = value;
    if (configId === 'reasoning_effort') {
      if (!state.currentModelId || !state.reasoningEfforts.includes(value)) {
        return {
          toRuntime: [],
          toClient: [errorResponse(message.id, 'Unsupported Grok reasoning effort')],
        };
      }
      translated = {
        jsonrpc: '2.0',
        id: message.id,
        method: 'session/set_model',
        params: {
          sessionId,
          modelId: state.currentModelId,
          _meta: {
            [runtimeManifest.privateWireContract.reasoningEffortMeta]: value,
          },
        },
      };
    } else if (configId === 'model') {
      translated = {
        jsonrpc: '2.0',
        id: message.id,
        method: 'session/set_model',
        params: { sessionId, modelId: value },
      };
    } else if (configId === 'interaction_mode' && INTERACTION_TO_RUNTIME[value]) {
      effectiveValue = INTERACTION_FROM_RUNTIME[INTERACTION_TO_RUNTIME[value]] ?? value;
      translated = {
        jsonrpc: '2.0',
        id: message.id,
        method: 'session/set_mode',
        params: { sessionId, modeId: INTERACTION_TO_RUNTIME[value] },
      };
    } else {
      return {
        toRuntime: [],
        toClient: [errorResponse(message.id, `Unsupported Grok config option: ${configId}`)],
      };
    }
    this.pending.set(message.id, {
      kind: 'config',
      sessionId,
      configId,
      value: effectiveValue,
    });
    return { toRuntime: [translated], toClient: [] };
  }

  handleRuntime(message) {
    if (!message || typeof message !== 'object') return { toRuntime: [], toClient: [message] };
    const logicalMethod = logicalExtensionMethod(message.method);
    if (logicalMethod === runtimeManifest.privateWireContract.sessionUpdateNotification) {
      const sessionId = message.params?.sessionId;
      const update = message.params?.update;
      const state = this.sessions.get(sessionId);
      if (
        state &&
        update?.sessionUpdate === runtimeManifest.privateWireContract.turnCompletedUpdate
      ) {
        const promptId = update.prompt_id ?? update.promptId;
        const isReplay = message.params?._meta?.isReplay === true;
        const toRuntime = [];
        const toClient = [message];
        if (!isReplay) {
          const usage = this.usageForPrompt(state, promptId, update.usage);
          if (usage) toClient.push(usage);
          toRuntime.push(...this.usageRefreshRequestsForPrompt(state, promptId));
        }
        return { toRuntime, toClient };
      }
      return { toRuntime: [], toClient: [message] };
    }

    if (message.method === 'session/update') {
      const sessionId = message.params?.sessionId;
      const update = message.params?.update;
      const state = this.sessions.get(sessionId);
      if (state && update?.sessionUpdate === 'current_mode_update') {
        const interactionMode = INTERACTION_FROM_RUNTIME[update.currentModeId];
        if (interactionMode) state.interactionMode = interactionMode;
      }
      return { toRuntime: [], toClient: [message] };
    }

    if (logicalMethod === runtimeManifest.privateWireContract.sessionNotification) {
      const sessionId = message.params?.sessionId;
      const update = message.params?.update;
      const state = this.sessions.get(sessionId);
      if (state && update?.sessionUpdate === 'model_changed') {
        const modelId = update.model_id ?? update.modelId;
        const reasoningEffort = update.reasoning_effort ?? update.reasoningEffort;
        if (typeof modelId === 'string') state.currentModelId = modelId;
        if (typeof reasoningEffort === 'string') state.reasoningEffort = reasoningEffort;
        return {
          toRuntime: [this.internalRequest('context', sessionId)],
          toClient: [message],
        };
      }
      return { toRuntime: [], toClient: [message] };
    }

    // JSON-RPC request IDs are scoped independently in each direction. Never
    // mistake a reverse request from Grok for a response to a Lody request that
    // happens to use the same numeric ID.
    if (typeof message.method === 'string') {
      return { toRuntime: [], toClient: [message] };
    }

    const pending = this.pending.get(message.id);
    if (!pending) return { toRuntime: [], toClient: [message] };
    this.pending.delete(message.id);

    if (pending.kind === 'context') {
      if (message.error) return { toRuntime: [], toClient: [] };
      const sessionInfo = unwrapExtensionResult(message.result);
      const contextNotification = contextUsageNotification(pending.sessionId, sessionInfo?.context);
      return {
        toRuntime: [],
        toClient: contextNotification ? [contextNotification] : [],
      };
    }

    if (pending.kind === 'billing') {
      if (message.error) {
        return {
          toRuntime: [],
          toClient: [
            {
              jsonrpc: '2.0',
              method: wireExtensionMethod(
                runtimeManifest.privateWireContract.lodyRateLimitsNotification
              ),
              params: unavailableRateLimits(),
            },
          ],
        };
      }
      const notification = rateLimitsNotification(unwrapExtensionResult(message.result));
      return {
        toRuntime: [],
        toClient: notification ? [notification] : [],
      };
    }

    if (message.error) return { toRuntime: [], toClient: [message] };

    if (pending.kind === 'session') {
      const result = message.result ?? {};
      const sessionId = result.sessionId ?? pending.sessionId;
      if (!sessionId) return { toRuntime: [], toClient: [message] };
      const state = this.stateFromSessionResponse(sessionId, pending.clientIdentifier, result);
      this.sessions.set(sessionId, state);
      return {
        toRuntime: [
          this.internalRequest('context', sessionId),
          this.internalRequest('billing', sessionId),
        ],
        toClient: [
          {
            ...message,
            result: { ...result, configOptions: this.configOptions(state) },
          },
        ],
      };
    }

    if (pending.kind === 'prompt') {
      const state = this.sessions.get(pending.sessionId);
      if (!state) return { toRuntime: [], toClient: [message] };
      const meta = message.result?._meta;
      const promptId = meta?.promptId ?? meta?.requestId;
      const usage = this.usageForPrompt(state, promptId, meta?.usage);
      return {
        toRuntime: this.usageRefreshRequestsForPrompt(state, promptId),
        toClient: usage ? [message, usage] : [message],
      };
    }

    const state = this.sessions.get(pending.sessionId);
    if (!state) return { toRuntime: [], toClient: [message] };
    if (pending.configId === 'model') state.currentModelId = pending.value;
    if (pending.configId === 'reasoning_effort') state.reasoningEffort = pending.value;
    if (pending.configId === 'interaction_mode') state.interactionMode = pending.value;
    return {
      toRuntime: [],
      toClient: [
        {
          jsonrpc: '2.0',
          id: message.id,
          result: { configOptions: this.configOptions(state) },
        },
      ],
    };
  }

  stateFromSessionResponse(sessionId, clientIdentifier, result) {
    const old = this.sessions.get(sessionId);
    const clientPermissionState =
      !old && typeof clientIdentifier === 'string' && clientIdentifier.length > 0
        ? Array.from(this.sessions.values()).find(
            (state) => state.clientIdentifier === clientIdentifier
          )
        : undefined;
    const legacy = legacyOptions(result);
    const legacyModels = legacy.filter((option) => option.category === 'model');
    const legacyEfforts = legacy.filter((option) => option.category === 'mode');
    const availableModels = result.models?.availableModels ?? [];
    const currentModelId =
      result.models?.currentModelId ??
      legacyModels.find((option) => option.selected)?.id ??
      old?.currentModelId;
    const currentModel = availableModels.find((model) => model.modelId === currentModelId);
    const metadataEfforts = readReasoningEfforts(currentModel);
    const reasoningEfforts = metadataEfforts.length
      ? metadataEfforts
      : legacyEfforts.map((option) => option.id);
    return {
      sessionId,
      clientIdentifier: clientIdentifier ?? old?.clientIdentifier,
      permissionMode: old?.permissionMode ?? clientPermissionState?.permissionMode ?? 'ask',
      interactionMode:
        INTERACTION_FROM_RUNTIME[result.modes?.currentModeId] ?? old?.interactionMode ?? 'agent',
      currentModelId,
      models: availableModels.length
        ? availableModels
        : legacyModels.map((option) => ({
            modelId: option.id,
            name: option.label,
            description: option.description,
          })),
      reasoningEfforts,
      reasoningEffort:
        legacyEfforts.find((option) => option.selected)?.id ??
        old?.reasoningEffort ??
        reasoningEfforts[0],
      usagePromptIds: old?.usagePromptIds ?? new Set(),
      usageRefreshPromptIds: old?.usageRefreshPromptIds ?? new Set(),
    };
  }

  configOptions(state) {
    const modes = [
      {
        value: 'agent',
        name: 'Agent',
        description: 'Use tools and make changes when needed',
      },
      {
        value: 'plan',
        name: 'Plan',
        description: 'Plan without modifying the workspace',
      },
    ];
    const permissions = [
      {
        value: 'ask',
        name: 'Ask Every Time',
        description: 'Request approval for protected actions',
      },
      {
        value: 'always-approve',
        name: 'Always Approve',
        description: 'Approve protected actions automatically',
      },
    ];
    if (runtimeManifest.privateWireContract.autoPermissionMode) {
      permissions.splice(1, 0, {
        value: 'auto',
        name: 'Auto',
        description: 'Let Grok decide when approval is required',
      });
    }
    const options = [
      selectOption(
        'interaction_mode',
        'Interaction Mode',
        'Controls how Grok works',
        state.interactionMode,
        modes,
        'mode'
      ),
      selectOption(
        'permission_mode',
        'Permission Mode',
        'Controls protected tool approvals',
        state.permissionMode,
        permissions,
        '_permission'
      ),
    ];
    if (state.currentModelId) {
      options.push(
        selectOption(
          'model',
          'Model',
          'Select the model used for this session',
          state.currentModelId,
          state.models.map((model) => ({
            value: model.modelId,
            name: model.name || model.modelId,
            description: model.description ?? null,
          })),
          'model'
        )
      );
    }
    if (state.reasoningEfforts.length && state.reasoningEffort) {
      options.push(
        selectOption(
          'reasoning_effort',
          'Reasoning Effort',
          'Controls how much reasoning the model performs',
          state.reasoningEffort,
          state.reasoningEfforts.map((value) => ({
            value,
            name: optionName(value),
            description: null,
          })),
          'thought_level'
        )
      );
    }
    return options;
  }
}
