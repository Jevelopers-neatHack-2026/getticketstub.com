import test from 'node:test';
import assert from 'node:assert/strict';
import { browserLaunchArguments, connect } from '../scripts/lib/cdp.mjs';

test('default browser consumers retain all original launch arguments and order', () => {
  const profile = '/synthetic/ticketstub-chrome-default';
  const original = [
    '--headless=new', '--mute-audio', '--disable-features=HardwareMediaKeyHandling', '--disable-gpu',
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1 , EXCLUDE localhost', 'about:blank',
  ];
  assert.deepEqual(browserLaunchArguments(profile), original);
  assert.deepEqual(browserLaunchArguments(profile, { downloadIsolation: false }), original);
});

test('download isolation adds only its two extension flags without changing later default launches', () => {
  const profile = '/synthetic/ticketstub-chrome-download';
  const original = browserLaunchArguments(profile);
  const isolated = browserLaunchArguments(profile, { downloadIsolation: true });
  const flags = ['--disable-extensions', '--disable-component-extensions-with-background-pages'];
  assert.deepEqual(isolated.filter((argument) => !flags.includes(argument)), original);
  assert.deepEqual(isolated.filter((argument) => flags.includes(argument)), flags);
  assert.equal(isolated.at(-1), 'about:blank');
  assert.deepEqual(browserLaunchArguments(profile), original);
});

// Deterministic synthetic transport controls; these make no browser or network request.
function opening() {
  const instances = [];
  class Socket {
    constructor(url) { this.url = url; this.sent = []; this.closeCalls = 0; instances.push(this); }
    send(data) { if (this.sendError) throw this.sendError; this.sent.push(JSON.parse(data)); }
    close() { this.closeCalls++; }
    message(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  }
  const promise = connect('ws://127.0.0.1/devtools/synthetic', Socket);
  return { socket: instances[0], promise };
}

async function connected() {
  const state = opening();
  state.socket.onopen();
  return { socket: state.socket, conn: await state.promise };
}

test('CDP replies remain correlated by ID across out-of-order responses', async () => {
  const { socket, conn } = await connected();
  const first = conn.send('Runtime.evaluate', { expression: '1' }, 'session-one');
  const second = conn.send('Browser.getVersion');
  assert.deepEqual(socket.sent[0], { id: 1, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: 'session-one' });
  socket.message({ id: 2, result: { product: 'synthetic' } });
  socket.message({ id: 1, result: { value: 1 } });
  assert.deepEqual(await second, { product: 'synthetic' });
  assert.deepEqual(await first, { value: 1 });
});

test('socket close rejects every pending command instead of leaving it unresolved', { timeout: 1000 }, async () => {
  const { socket, conn } = await connected();
  const outcomes = Promise.all([
    assert.rejects(conn.send('Browser.close'), /DevTools socket closed/),
    assert.rejects(conn.send('Runtime.evaluate'), /DevTools socket closed/),
  ]);
  socket.onclose();
  await outcomes;
});

test('commands after disconnect are refused without another socket send', async () => {
  const { socket, conn } = await connected();
  socket.onclose();
  await assert.rejects(conn.send('Browser.getVersion'), /DevTools socket closed/);
  assert.equal(socket.sent.length, 0);
});

test('a socket that closes before opening rejects connection setup', { timeout: 1000 }, async () => {
  const { socket, promise } = opening();
  const outcome = assert.rejects(promise, /DevTools socket closed/);
  socket.onclose();
  await outcome;
});

test('a socket error rejects pending work and preserves that first failure', { timeout: 1000 }, async () => {
  const { socket, conn } = await connected();
  const outcome = assert.rejects(conn.send('Runtime.evaluate'), /DevTools socket error/);
  socket.onerror();
  socket.onclose();
  await outcome;
  await assert.rejects(conn.send('Browser.getVersion'), /DevTools socket error/);
  assert.equal(socket.sent.length, 1);
});

test('an error before open cannot revive a failed connection', async () => {
  const { socket, promise } = opening();
  const outcome = assert.rejects(promise, /DevTools socket error/);
  socket.onerror();
  await outcome;
  socket.onopen();
  assert.equal(socket.closeCalls, 1);
});

test('a protocol error rejects its command without disconnecting other work', async () => {
  const { socket, conn } = await connected();
  const rejected = assert.rejects(conn.send('Invalid.command'), /unknown command/);
  const valid = conn.send('Browser.getVersion');
  socket.message({ id: 1, error: { message: 'unknown command' } });
  socket.message({ id: 2, result: { product: 'synthetic' } });
  await rejected;
  assert.deepEqual(await valid, { product: 'synthetic' });
});

test('a synchronous send failure rejects promptly and does not poison later commands', async () => {
  const { socket, conn } = await connected();
  socket.sendError = new Error('synthetic send failure');
  await assert.rejects(conn.send('Browser.getVersion'), /synthetic send failure/);
  socket.sendError = null;
  const valid = conn.send('Browser.getVersion');
  socket.message({ id: 2, result: { product: 'synthetic' } });
  assert.deepEqual(await valid, { product: 'synthetic' });
  socket.onclose();
});

test('disconnect releases event listeners and refuses later subscriptions', async () => {
  const { socket, conn } = await connected();
  let called = 0;
  conn.on(() => called++);
  socket.message({ method: 'Page.loadEventFired', params: {} });
  assert.equal(called, 1);
  socket.onclose();
  conn.on(() => called++);
  socket.message({ method: 'Page.loadEventFired', params: {} });
  assert.equal(called, 1);
});
