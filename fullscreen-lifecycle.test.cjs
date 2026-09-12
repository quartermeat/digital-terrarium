const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('fullscreen yields both renderers, then restores without focus; errors recover', async () => {
  const events = [];
  let detector = { fullscreen: true, window: '0x123' };
  const scene = {
    isDestroyed: () => false,
    hide: () => events.push('hide'),
    loadURL: async url => events.push(url),
    showInactive: () => events.push('showInactive'),
  };
  const electron = {
    app: { on() {}, whenReady: () => ({ then: () => ({ catch() {} }) }) },
    BrowserWindow: class {
      constructor() { events.push('camera-created'); }
      on() {}
      async loadURL(url) { events.push(url); }
      destroy() { events.push('camera-stopped'); }
    },
  };
  const context = vm.createContext({
    require: name => name === 'electron' ? electron
      : name === 'node:util' ? { promisify: () => async () => {
        if (detector instanceof Error) throw detector;
        return { stdout: JSON.stringify(detector) };
      } } : require(name),
    process: { argv: ['--terrarium'], env: {} },
    __dirname, console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 1, clearTimeout() {}, scene,
  });
  vm.runInContext(fs.readFileSync(__dirname + '/electron-main.js', 'utf8') +
    '\nsceneWindow = scene; visionWindow = new BrowserWindow();', context);
  events.length = 0;
  await vm.runInContext('checkFullscreenPriority()', context);
  assert.deepEqual(events, ['hide', 'camera-stopped', 'about:blank']);
  events.length = 0;
  await vm.runInContext('checkFullscreenPriority()', context);
  assert.deepEqual(events, [], 'remaining fullscreen must not reload anything');
  detector = { fullscreen: false };
  await vm.runInContext('checkFullscreenPriority()', context);
  assert.deepEqual(events, ['http://127.0.0.1:8091/terrarium.html', 'showInactive',
    'camera-created', 'http://127.0.0.1:8091/vision.html']);
  for (const failure of [{ error: 'display unavailable' }, new Error('timeout')]) {
    detector = { fullscreen: true };
    await vm.runInContext('checkFullscreenPriority()', context);
    events.length = 0;
    detector = failure;
    await vm.runInContext('checkFullscreenPriority()', context);
    assert.ok(events.includes('showInactive'), 'detector failure must restore scene');
  }
});
