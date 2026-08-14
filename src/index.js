#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { GrokAcpCompatibilityProxy } from './proxy.js';
import { spawnGrokRuntime } from './runtime-process.js';

const grokPath = process.env.GROK_PATH;
if (!grokPath) {
  console.error('GROK_PATH must point to the official Grok runtime');
  process.exit(1);
}

const child = spawnGrokRuntime(grokPath);
const proxy = new GrokAcpCompatibilityProxy();

function write(stream, message) {
  stream.write(`${JSON.stringify(message)}\n`);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  try {
    const output = proxy.handleClient(JSON.parse(line));
    for (const message of output.toRuntime) write(child.stdin, message);
    for (const message of output.toClient) write(process.stdout, message);
  } catch (error) {
    console.error(
      `Invalid ACP client message: ${error instanceof Error ? error.message : String(error)}`
    );
  }
});

createInterface({ input: child.stdout }).on('line', (line) => {
  try {
    const output = proxy.handleRuntime(JSON.parse(line));
    for (const message of output.toRuntime) write(child.stdin, message);
    for (const message of output.toClient) write(process.stdout, message);
  } catch (error) {
    console.error(
      `Invalid Grok runtime message: ${error instanceof Error ? error.message : String(error)}`
    );
  }
});

process.stdin.on('end', () => child.stdin.end());
child.on('error', (error) => {
  console.error(`Failed to launch official Grok runtime: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
