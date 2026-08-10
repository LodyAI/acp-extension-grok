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

const INTERACTION_TO_RUNTIME = { agent: 'default', plan: 'plan', ask: 'ask' };
const INTERACTION_FROM_RUNTIME = { default: 'agent', plan: 'plan', ask: 'ask' };

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
    method: runtimeManifest.privateWireContract.permissionNotification,
    params: { clientIdentifier, ...mapped },
  };
}

export class GrokAcpCompatibilityProxy {
  constructor() {
    this.sessions = new Map();
    this.pending = new Map();
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
      state.permissionMode = value;
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
      value,
    });
    return { toRuntime: [translated], toClient: [] };
  }

  handleRuntime(message) {
    if (!message || typeof message !== 'object') return { toRuntime: [], toClient: [message] };
    if (message.method === runtimeManifest.privateWireContract.sessionNotification) {
      const sessionId = message.params?.sessionId;
      const update = message.params?.update;
      const state = this.sessions.get(sessionId);
      if (state && update?.sessionUpdate === 'model_changed') {
        const modelId = update.model_id ?? update.modelId;
        const reasoningEffort = update.reasoning_effort ?? update.reasoningEffort;
        if (typeof modelId === 'string') state.currentModelId = modelId;
        if (typeof reasoningEffort === 'string') state.reasoningEffort = reasoningEffort;
      }
      return { toRuntime: [], toClient: [message] };
    }

    const pending = this.pending.get(message.id);
    if (!pending) return { toRuntime: [], toClient: [message] };
    this.pending.delete(message.id);
    if (message.error) return { toRuntime: [], toClient: [message] };

    if (pending.kind === 'session') {
      const result = message.result ?? {};
      const sessionId = result.sessionId ?? pending.sessionId;
      if (!sessionId) return { toRuntime: [], toClient: [message] };
      const state = this.stateFromSessionResponse(sessionId, pending.clientIdentifier, result);
      this.sessions.set(sessionId, state);
      return {
        toRuntime: [],
        toClient: [
          {
            ...message,
            result: { ...result, configOptions: this.configOptions(state) },
          },
        ],
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
      permissionMode: old?.permissionMode ?? 'ask',
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
      {
        value: 'ask',
        name: 'Ask',
        description: 'Answer without modifying the workspace',
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
