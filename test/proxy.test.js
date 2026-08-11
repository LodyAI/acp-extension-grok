import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GrokAcpCompatibilityProxy,
  normalizePromptUsage,
  permissionNotification,
} from '../src/proxy.js';
import runtimeManifest from '../runtime-manifest.json' with { type: 'json' };

const clientIdentifier = 'lody:session-1';
const sessionResponse = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    sessionId: 'grok-session',
    models: {
      currentModelId: 'grok-build',
      availableModels: [{ modelId: 'grok-build', name: 'Grok Build' }],
    },
    modes: { currentModeId: 'default' },
    _meta: {
      'x.ai/sessionConfig': {
        options: [
          {
            id: 'grok-build',
            category: 'model',
            label: 'Grok Build',
            selected: true,
          },
          { id: 'low', category: 'mode', label: 'Low', selected: false },
          { id: 'high', category: 'mode', label: 'High', selected: true },
        ],
      },
    },
  },
};

function readyProxy() {
  const proxy = new GrokAcpCompatibilityProxy();
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 1,
    method: 'session/new',
    params: {
      cwd: '/tmp/project',
      mcpServers: [],
      _meta: { clientIdentifier },
    },
  });
  const startup = proxy.handleRuntime(sessionResponse);
  return { proxy, startup, response: startup.toClient[0] };
}

const promptUsage = {
  inputTokens: 1_000,
  outputTokens: 250,
  cachedReadTokens: 300,
  cacheCreationTokens: 100,
  reasoningTokens: 50,
  costUsdTicks: 250_000_000,
  modelUsage: {
    'grok-build': {
      inputTokens: 1_000,
      outputTokens: 250,
      cachedReadTokens: 300,
      cacheCreationTokens: 100,
      reasoningTokens: 50,
      costUsdTicks: 250_000_000,
    },
  },
  numTurns: 1,
  usageIsIncomplete: false,
};

test('pins and synthesizes the official 1.0.0 private wire contract', () => {
  assert.equal(runtimeManifest.officialRuntime.minimumSupportedVersion, '1.0.0');
  assert.deepEqual(
    {
      sessionUpdateNotification: runtimeManifest.privateWireContract.sessionUpdateNotification,
      turnCompletedUpdate: runtimeManifest.privateWireContract.turnCompletedUpdate,
      sessionInfoRequest: runtimeManifest.privateWireContract.sessionInfoRequest,
      lodyUsageNotification: runtimeManifest.privateWireContract.lodyUsageNotification,
    },
    {
      sessionUpdateNotification: 'x.ai/session/update',
      turnCompletedUpdate: 'turn_completed',
      sessionInfoRequest: 'x.ai/session/info',
      lodyUsageNotification: 'acp_ext:session_usage_update',
    }
  );
  const { response } = readyProxy();
  assert.deepEqual(
    response.result.configOptions.map((option) => option.id),
    ['interaction_mode', 'permission_mode', 'model', 'reasoning_effort']
  );
  assert.equal(
    response.result.configOptions.find((option) => option.id === 'reasoning_effort').currentValue,
    'high'
  );
  assert.deepEqual(
    response.result.configOptions
      .find((option) => option.id === 'permission_mode')
      .options.map((option) => option.value),
    ['ask', 'always-approve']
  );
});

test('maps every permission mode to the official notification contract', () => {
  assert.deepEqual(permissionNotification(clientIdentifier, 'ask').params, {
    clientIdentifier,
    permission_mode: 'ask',
    yolo_mode: false,
    auto_mode: false,
  });
  assert.deepEqual(permissionNotification(clientIdentifier, 'auto').params, {
    clientIdentifier,
    permission_mode: 'auto',
    yolo_mode: false,
    auto_mode: true,
  });
  assert.deepEqual(permissionNotification(clientIdentifier, 'always-approve').params, {
    clientIdentifier,
    permission_mode: 'always-approve',
    yolo_mode: true,
    auto_mode: false,
  });
});

test('optimistically syncs ask and always-approve without forwarding set_config_option', () => {
  const { proxy } = readyProxy();
  const output = proxy.handleClient({
    jsonrpc: '2.0',
    id: 2,
    method: 'session/set_config_option',
    params: {
      sessionId: 'grok-session',
      configId: 'permission_mode',
      value: 'always-approve',
    },
  });
  assert.equal(output.toRuntime.length, 1);
  assert.equal(output.toRuntime[0].method, 'x.ai/yolo_mode_changed');
  assert.equal(output.toRuntime[0].params.clientIdentifier, clientIdentifier);
  assert.equal(
    output.toClient[0].result.configOptions.find((option) => option.id === 'permission_mode')
      .currentValue,
    'always-approve'
  );
});

test('gracefully rejects auto while the pinned runtime gate cannot be confirmed', () => {
  const { proxy } = readyProxy();
  const output = proxy.handleClient({
    jsonrpc: '2.0',
    id: 3,
    method: 'session/set_config_option',
    params: {
      sessionId: 'grok-session',
      configId: 'permission_mode',
      value: 'auto',
    },
  });
  assert.equal(output.toRuntime.length, 0);
  assert.equal(output.toClient[0].error.code, -32602);
});

test('translates reasoning effort through set_model and preserves the model id', () => {
  const { proxy } = readyProxy();
  const request = proxy.handleClient({
    jsonrpc: '2.0',
    id: 4,
    method: 'session/set_config_option',
    params: {
      sessionId: 'grok-session',
      configId: 'reasoning_effort',
      value: 'low',
    },
  }).toRuntime[0];
  assert.deepEqual(request, {
    jsonrpc: '2.0',
    id: 4,
    method: 'session/set_model',
    params: {
      sessionId: 'grok-session',
      modelId: 'grok-build',
      _meta: { reasoningEffort: 'low' },
    },
  });
  const response = proxy.handleRuntime({ jsonrpc: '2.0', id: 4, result: {} }).toClient[0];
  assert.equal(
    response.result.configOptions.find((option) => option.id === 'reasoning_effort').currentValue,
    'low'
  );
});

test('requires the Lody clientIdentifier before changing permissions', () => {
  const proxy = new GrokAcpCompatibilityProxy();
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 1,
    method: 'session/new',
    params: { cwd: '/tmp', mcpServers: [] },
  });
  proxy.handleRuntime(sessionResponse);
  const output = proxy.handleClient({
    jsonrpc: '2.0',
    id: 5,
    method: 'session/set_config_option',
    params: {
      sessionId: 'grok-session',
      configId: 'permission_mode',
      value: 'ask',
    },
  });
  assert.equal(output.toRuntime.length, 0);
  assert.match(output.toClient[0].error.message, /clientIdentifier/);
});

test('restores optimistic permission state across session reload in the same wrapper', () => {
  const { proxy } = readyProxy();
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 6,
    method: 'session/set_config_option',
    params: {
      sessionId: 'grok-session',
      configId: 'permission_mode',
      value: 'always-approve',
    },
  });
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 7,
    method: 'session/load',
    params: {
      sessionId: 'grok-session',
      cwd: '/tmp/project',
      mcpServers: [],
      _meta: { clientIdentifier },
    },
  });
  const loaded = proxy.handleRuntime({
    ...sessionResponse,
    id: 7,
    result: { ...sessionResponse.result, sessionId: undefined },
  }).toClient[0];
  assert.equal(
    loaded.result.configOptions.find((option) => option.id === 'permission_mode').currentValue,
    'always-approve'
  );
});

test('tracks the official snake_case model_changed notification', () => {
  const { proxy } = readyProxy();
  const modelChanged = proxy.handleRuntime({
    jsonrpc: '2.0',
    method: 'x.ai/session_notification',
    params: {
      sessionId: 'grok-session',
      update: {
        sessionUpdate: 'model_changed',
        model_id: 'grok-4',
        reasoning_effort: 'low',
      },
    },
  });
  assert.equal(modelChanged.toRuntime[0].method, '_x.ai/session/info');
  const request = proxy.handleClient({
    jsonrpc: '2.0',
    id: 8,
    method: 'session/set_config_option',
    params: { sessionId: 'grok-session', configId: 'reasoning_effort', value: 'high' },
  }).toRuntime[0];
  assert.equal(request.params.modelId, 'grok-4');
});

test('normalizes official inclusive token counters into Lody disjoint usage buckets', () => {
  assert.deepEqual(normalizePromptUsage(promptUsage), {
    usage: {
      inputTokens: 600,
      outputTokens: 200,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 100,
      reasoningOutputTokens: 50,
      costUSD: 0.025,
    },
    modelUsage: {
      'grok-build': {
        inputTokens: 600,
        outputTokens: 200,
        cacheReadInputTokens: 300,
        cacheCreationInputTokens: 100,
        reasoningOutputTokens: 50,
        costUSD: 0.025,
      },
    },
  });
});

test('drops untrustworthy costs while preserving incomplete token usage', () => {
  const normalized = normalizePromptUsage({
    ...promptUsage,
    usageIsIncomplete: true,
    modelUsage: {
      'grok-build': { ...promptUsage.modelUsage['grok-build'], costIsPartial: true },
    },
  });
  assert.equal(normalized.usage.costUSD, undefined);
  assert.equal(normalized.modelUsage['grok-build'].costUSD, undefined);
  assert.equal(normalized.usage.inputTokens, 600);
});

test('emits Lody token usage and requests authoritative context on turn completion', () => {
  const { proxy } = readyProxy();
  const output = proxy.handleRuntime({
    jsonrpc: '2.0',
    method: '_x.ai/session/update',
    params: {
      sessionId: 'grok-session',
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'prompt-1',
        stop_reason: 'end_turn',
        usage: promptUsage,
      },
    },
  });

  assert.equal(output.toClient[0].method, '_x.ai/session/update');
  assert.equal(output.toClient[1].method, '_acp_ext:session_usage_update');
  assert.deepEqual(output.toClient[1].params, normalizePromptUsage(promptUsage));
  assert.equal(output.toRuntime.length, 1);
  assert.equal(output.toRuntime[0].method, '_x.ai/session/info');
  assert.deepEqual(output.toRuntime[0].params, { sessionId: 'grok-session' });
});

test('converts session info context into standard ACP usage_update for the existing UI', () => {
  const { proxy, startup } = readyProxy();
  assert.equal(startup.toRuntime.length, 1);
  assert.equal(startup.toRuntime[0].method, '_x.ai/session/info');

  const output = proxy.handleRuntime({
    jsonrpc: '2.0',
    id: startup.toRuntime[0].id,
    result: {
      sessionId: 'grok-session',
      context: { used: 81_920, total: 256_000, freeTokens: 174_080, usagePct: 32 },
    },
  });

  assert.equal(output.toRuntime.length, 0);
  assert.deepEqual(output.toClient, [
    {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'grok-session',
        update: { sessionUpdate: 'usage_update', size: 256_000, used: 81_920 },
      },
    },
  ]);
});

test('uses prompt response usage as a fallback and deduplicates turn_completed', () => {
  const { proxy } = readyProxy();
  proxy.handleClient({
    jsonrpc: '2.0',
    id: 20,
    method: 'session/prompt',
    params: { sessionId: 'grok-session', prompt: [] },
  });
  const promptResponse = proxy.handleRuntime({
    jsonrpc: '2.0',
    id: 20,
    result: {
      stopReason: 'end_turn',
      _meta: { sessionId: 'grok-session', promptId: 'prompt-2', usage: promptUsage },
    },
  });
  assert.equal(promptResponse.toClient[1].method, '_acp_ext:session_usage_update');
  assert.equal(promptResponse.toRuntime[0].method, '_x.ai/session/info');

  const durableCompletion = proxy.handleRuntime({
    jsonrpc: '2.0',
    method: '_x.ai/session/update',
    params: {
      sessionId: 'grok-session',
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'prompt-2',
        stop_reason: 'end_turn',
        usage: promptUsage,
      },
    },
  });
  assert.equal(durableCompletion.toClient.length, 1);
  assert.equal(durableCompletion.toRuntime.length, 0);
});

test('does not record or re-query historical usage from replayed completions', () => {
  const { proxy } = readyProxy();
  const replay = proxy.handleRuntime({
    jsonrpc: '2.0',
    method: '_x.ai/session/update',
    params: {
      sessionId: 'grok-session',
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'old-prompt',
        stop_reason: 'end_turn',
        usage: promptUsage,
      },
      _meta: { isReplay: true },
    },
  });
  assert.equal(replay.toClient.length, 1);
  assert.equal(replay.toRuntime.length, 0);
});
