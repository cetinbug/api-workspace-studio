// Manual Electron IPC smoke test. Start `npm run dev:web` first, then run this file.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { _electron } = require('playwright');
const { userWorkspacePath } = require('../../packages/bruno-electron/src/studio/workspace');

const root = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-desktop-'));
const userData = path.join(temp, 'user-data');
fs.mkdirSync(userData);
const environment = { ...process.env, BRUNO_DEV_PORT: '3000', ELECTRON_USER_DATA_PATH: userData };
delete environment.ELECTRON_RUN_AS_NODE;

let electronApp;
let server;
const ipc = (page, channel, ...args) => page.evaluate(
  ([name, parameters]) => window.ipcRenderer.invoke(name, ...parameters),
  [channel, args]
);

(async () => {
  try {
    electronApp = await _electron.launch({
      executablePath: require('electron'),
      args: [path.join(root, 'packages/bruno-electron')],
      cwd: root,
      env: environment,
      timeout: 60000
    });
    const page = await electronApp.firstWindow();
    await page.locator('.app-titlebar').waitFor({ timeout: 60000 });
    assert.match(await page.locator('.bruno-text').textContent(), /API Workspace Studio/);

    const created = await ipc(page, 'renderer:create-workspace', 'Smoke Workspace', 'smoke-workspace', temp);
    const workspace = created.workspacePath;
    await ipc(page, 'studio:init', workspace, 'Test');
    const state = await ipc(page, 'studio:get', workspace, 'Test');
    const manifest = state.manifest;
    manifest.secrets['service.api-key'] = { name: 'Service API Key' };
    manifest.environments.Test.bindings.apiKey = 'service.api-key';
    manifest.environments.Test.secrets['service.api-key'] = { reference: 'test-service-key' };
    await ipc(page, 'studio:save-manifest', workspace, manifest);
    await ipc(page, 'studio:set-mock', workspace, 'local-mock', 'test-service-key', 'MOCK_SMOKE_SECRET');
    assert.equal((await ipc(page, 'studio:check-secrets', workspace, 'Test')).apiKey, 'mock');
    assert.doesNotMatch(fs.readFileSync(path.join(workspace, '.apiworkspace', 'manifest.json'), 'utf8'), /MOCK_SMOKE_SECRET/);
    let receivedKey = null;
    server = http.createServer((request, response) => {
      receivedKey = request.headers['x-api-key'];
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    await ipc(page, 'renderer:create-collection', 'Smoke Collection', 'smoke-collection', path.join(workspace, 'collections'));
    const collectionPath = path.join(workspace, 'collections', 'smoke-collection');
    const item = {
      uid: 'smoke-request', name: 'Smoke Request', type: 'http-request',
      pathname: path.join(collectionPath, 'Smoke Request.bru'),
      request: {
        method: 'GET', url: `http://127.0.0.1:${server.address().port}/`,
        headers: [{ name: 'x-api-key', value: '{{apiKey}}', enabled: true }],
        params: [], body: { mode: 'none' }, auth: { mode: 'none' }, vars: { req: [], res: [] },
        script: { req: '', res: '' }, tests: ''
      },
      settings: {}
    };
    const collection = { uid: 'smoke-collection', pathname: collectionPath, name: 'Smoke Collection',
      items: [item], root: {}, brunoConfig: {}, globalEnvironmentVariables: {} };
    const response = await ipc(page, 'send-http-request', item, collection, { name: 'Test', variables: [] }, {});
    assert.equal(response.status, 200, response.error || 'HTTP request failed');
    assert.equal(receivedKey, 'MOCK_SMOKE_SECRET');
    assert.equal(response.requestSent.headers['x-api-key'], '[REDACTED]');
    await ipc(page, 'studio:cache', workspace, 'enable', { password: 'strong-smoke-password' });
    await ipc(page, 'studio:check-secrets', workspace, 'Test');
    const cacheFile = path.join(userWorkspacePath(userData, workspace), 'cache.enc.json');
    assert.doesNotMatch(fs.readFileSync(cacheFile, 'utf8'), /MOCK_SMOKE_SECRET|strong-smoke-password/);
    await ipc(page, 'studio:set-simulation', workspace, 'local-mock', 'network');
    assert.match((await ipc(page, 'studio:check-secrets', workspace, 'Test')).apiKey, /^cached/);
    await ipc(page, 'studio:set-simulation', workspace, 'local-mock', '403');
    await assert.rejects(() => ipc(page, 'studio:check-secrets', workspace, 'Test'), /forbidden/i);
    console.log('Desktop smoke passed: app, workspace, HTTP request with mock secret, encrypted cache, network fallback, 403 block');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (electronApp) await electronApp.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
