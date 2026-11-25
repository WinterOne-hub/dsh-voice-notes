import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createDesktopCaptions } from '../desktop-captions.js';
import { verifiedCaptionHelper } from '../system-audio.js';

function streamResponse() {
  const response = new PassThrough();
  response.writeHead = (status, headers) => Object.assign(response, { status, headers, headersSent: true });
  response.resume();
  return response;
}

test('caption session forwards a complete normalized line and closes its helper on renderer disconnect', async (t) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.stdin.on('close', () => child.emit('close'));
  const received = [];
  child.stdin.on('data', (chunk) => received.push(chunk.toString()));
  child.kill = () => assert.fail('The helper should exit when its input closes');
  const bridge = createDesktopCaptions({
    getHelper: async () => 'verified-fixture',
    launch(executable, args, options) {
      assert.equal(executable, 'verified-fixture');
      assert.deepEqual(args, []);
      assert.equal(options.shell, false);
      queueMicrotask(() => child.stdout.write('rea'));
      setImmediate(() => child.stdout.write('dy\n'));
      return child;
    },
  });
  t.after(() => bridge.dispose());
  const response = streamResponse();
  assert.equal(await bridge.open('active', '简体中文\nEnglish', response), undefined);
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'private, no-store, no-transform');
  assert.equal(await bridge.open('other', '', streamResponse()), 'busy');
  assert.equal(bridge.update('other', 'unrelated'), false);
  assert.equal(bridge.update('active', 'x'.repeat(400)), true);
  assert.deepEqual(received, ['简体中文 English\n', 'x'.repeat(400) + '\n']);
  const closed = new Promise((resolve) => child.stdin.once('close', resolve));
  response.destroy();
  await closed;
  assert.equal(bridge.update('active', 'after disconnect'), false);
});

test('a renderer disconnect during verification prevents a delayed helper launch', async () => {
  const gate = Promise.withResolvers();
  const bridge = createDesktopCaptions({
    getHelper: () => gate.promise,
    launch() { assert.fail('No renderer remains to own the window'); },
  });
  const response = streamResponse();
  const opening = bridge.open('active', '', response);
  response.destroy();
  await new Promise((resolve) => response.once('close', resolve));
  gate.resolve('verified-fixture');
  await opening;
  assert.equal(bridge.update('active', 'after disconnect'), false);
});

test('the built native caption window accepts text and exits on disconnect', { timeout: 8000 }, async (t) => {
  try {
    await verifiedCaptionHelper();
  } catch (error) {
    if (error.code === 'missing' || error.code === 'unsupported') { t.skip('Native caption component unavailable'); return; }
    throw error;
  }
  let finished;
  const bridge = createDesktopCaptions({
    launch(executable, args, options) {
      const child = spawn(executable, args, options);
      finished = once(child, 'close');
      void finished.catch(() => {});
      return child;
    },
  });
  t.after(() => bridge.dispose());
  const response = streamResponse();
  assert.equal(await bridge.open('native', 'Voice Notes test', response), undefined);
  assert.equal(response.status, 200);
  assert.equal(bridge.update('native', '桌面字幕测试'), true);
  response.destroy();
  assert.deepEqual(await finished, [0, null]);
});
