import assert from 'node:assert/strict';
import test from 'node:test';
import { GrokAcpCompatibilityProxy, permissionNotification } from '../src/proxy.js';

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
  return { proxy, response: proxy.handleRuntime(sessionResponse).toClient[0] };
}

test('pins and synthesizes the official 1.0.0 private wire contract', () => {
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
  proxy.handleRuntime({
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
  const request = proxy.handleClient({
    jsonrpc: '2.0',
    id: 8,
    method: 'session/set_config_option',
    params: { sessionId: 'grok-session', configId: 'reasoning_effort', value: 'high' },
  }).toRuntime[0];
  assert.equal(request.params.modelId, 'grok-4');
});
