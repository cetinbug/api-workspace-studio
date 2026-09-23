const fs = require('fs');
const { app, ipcMain } = require('electron');
const { findWorkspace, readManifest, saveManifest } = require('../studio/workspace');
const { StudioSecrets } = require('../studio/secrets');
const { GitSync } = require('../studio/git-sync');

const sessions = new Map();
let windowRef = null;

const session = (workspacePath) => {
  const root = findWorkspace(workspacePath);
  if (!root) throw new Error('API Workspace Studio metadata not found in this workspace');
  if (!sessions.has(root)) {
    const sendStatus = () => {
      if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send('main:studio-git-status', root);
    };
    const current = {
      root,
      secrets: new StudioSecrets(root, app.getPath('userData')),
      git: new GitSync(root, app.getPath('userData'), sendStatus)
    };
    current.secrets.onResolvedSecret = (value) => current.git.registerSecret(value);
    sessions.set(root, current);
  }
  return sessions.get(root);
};

const managedFileSaved = (filename) => {
  const root = findWorkspace(filename);
  if (root) {
    const git = session(root).git;
    try { git.saved(filename); } catch (error) {
      git.lastError = `Saved locally, but Git sync skipped this file: ${error.message}`;
      git.onStatus();
    }
  }
};

const validateStudioWrite = (filename, content) => {
  const root = findWorkspace(filename);
  if (root) session(root).git.assertSafeContent(content);
};

const resolveForRequest = async (collectionPath, environmentName, baseVariables) => {
  const root = findWorkspace(collectionPath);
  if (!root || !environmentName) return { variables: baseVariables, sources: {} };
  const current = session(root);
  try {
    return await current.secrets.resolve(environmentName, baseVariables);
  } finally {
    if (windowRef && !windowRef.isDestroyed()) {
      windowRef.webContents.send('main:studio-secret-sources', root, current.secrets.lastSources);
    }
  }
};

const registerStudioIpc = (mainWindow) => {
  windowRef = mainWindow;
  ipcMain.handle('studio:init', async (_, workspacePath, environmentName) => {
    if (!fs.existsSync(workspacePath) || !fs.statSync(workspacePath).isDirectory()) throw new Error('Workspace folder not found');
    if (findWorkspace(workspacePath)) throw new Error('Workspace metadata already exists');
    const manifest = {
      version: 1,
      providers: { 'local-mock': { type: 'mock', name: 'Local Mock' } },
      secrets: {},
      environments: { [environmentName || 'Default']: { defaultProvider: 'local-mock', variables: {}, bindings: {}, secrets: {} } }
    };
    saveManifest(workspacePath, manifest);
    return session(workspacePath).secrets.inspect(environmentName || 'Default');
  });

  ipcMain.handle('studio:get', async (_, workspacePath, environmentName) => {
    const root = findWorkspace(workspacePath);
    if (!root) return { initialized: false };
    const current = session(root);
    const manifest = readManifest(root);
    const name = manifest.environments[environmentName] ? environmentName : Object.keys(manifest.environments)[0];
    return { initialized: true, root, environmentName: name,
      ...current.secrets.inspect(name), git: await current.git.status() };
  });

  ipcMain.handle('studio:check-secrets', async (_, workspacePath, environmentName) => {
    const current = session(workspacePath);
    try {
      await current.secrets.resolve(environmentName);
    } finally {
      if (windowRef && !windowRef.isDestroyed()) {
        windowRef.webContents.send('main:studio-secret-sources', current.root, current.secrets.lastSources);
      }
    }
    return current.secrets.lastSources;
  });

  ipcMain.handle('studio:save-manifest', async (_, workspacePath, manifest) => {
    const current = session(workspacePath);
    current.git.assertSafeContent(JSON.stringify(manifest));
    const filename = saveManifest(current.root, manifest);
    current.git.saved(filename);
    return current.secrets.inspect(Object.keys(manifest.environments)[0]);
  });

  ipcMain.handle('studio:set-mock', (_, workspacePath, providerId, reference, value) => {
    const current = session(workspacePath);
    if (!readManifest(current.root).providers[providerId] || typeof reference !== 'string' || !reference) throw new Error('Invalid mock secret reference');
    if (typeof value !== 'string') throw new Error('Mock secret must be text');
    const local = current.secrets.local();
    (local.mockSecrets[providerId] ||= {})[reference] = value;
    current.secrets.saveLocal(local);
    current.git.registerSecret(value);
    return true;
  });

  ipcMain.handle('studio:set-simulation', (_, workspacePath, providerId, failure, latencyMs = 0) => {
    const current = session(workspacePath);
    if (!readManifest(current.root).providers[providerId] || ![null, 'network', 'timeout', 'unavailable', '401', '403', '404'].includes(failure)
      || !Number.isSafeInteger(latencyMs) || latencyMs < 0 || latencyMs > 10000) throw new Error('Invalid mock simulation');
    const local = current.secrets.local();
    local.simulations[providerId] = { failure, latencyMs };
    current.secrets.saveLocal(local);
    return true;
  });

  ipcMain.handle('studio:set-source', (_, workspacePath, environmentName, variable, source) => {
    const current = session(workspacePath);
    if (!['local', 'remote'].includes(source) || !readManifest(current.root).environments[environmentName]) throw new Error('Invalid source choice');
    const local = current.secrets.local();
    (local.sources[environmentName] ||= {})[variable] = source;
    current.secrets.saveLocal(local);
    return true;
  });

  ipcMain.handle('studio:set-variable', (_, workspacePath, environmentName, variable, value) => {
    const current = session(workspacePath);
    const environment = readManifest(current.root).environments[environmentName];
    if (!environment || !variable || Object.hasOwn(environment.bindings, variable) || typeof value !== 'string') {
      throw new Error('Invalid ordinary local variable');
    }
    if (/password|secret|token|api.?key|private.?key/i.test(variable)) throw new Error('Use an encrypted local secret override for sensitive values');
    const local = current.secrets.local();
    (local.variables[environmentName] ||= {})[variable] = value;
    current.secrets.saveLocal(local);
    return true;
  });

  ipcMain.handle('studio:set-local-secret', (_, workspacePath, environmentName, variable, value) => {
    const current = session(workspacePath);
    const environment = readManifest(current.root).environments[environmentName];
    const mapping = environment?.secrets?.[environment.bindings?.[variable]];
    if (!mapping || typeof value !== 'string') throw new Error('Invalid local secret override');
    current.secrets.cache.putLocal(JSON.stringify([environmentName, mapping.provider || environment.defaultProvider, mapping.reference]), value);
    current.git.registerSecret(value);
    return true;
  });

  ipcMain.handle('studio:cache', (_, workspacePath, action, args = {}) => {
    const cache = session(workspacePath).secrets.cache;
    if (action === 'status') return cache.status();
    if (action === 'enable') return cache.enable(args.password, args.ttlMs);
    if (action === 'unlock') return cache.unlock(args.password);
    if (action === 'lock') return cache.lock();
    if (action === 'change-password') return cache.changePassword(args.oldPassword, args.newPassword);
    if (action === 'reset') return cache.reset();
    throw new Error('Unknown cache action');
  });

  ipcMain.handle('studio:git', async (_, workspacePath, action, arg) => {
    const git = session(workspacePath).git;
    if (action === 'status') return git.status();
    if (action === 'mode') return git.setMode(arg);
    if (action === 'fetch') {
      await git.fetch(); return git.status();
    }
    if (action === 'sync') return git.sync();
    if (action === 'sync-all') return git.syncAllManaged();
    if (action === 'pull') return git.pull();
    throw new Error('Unknown Git action');
  });

  const interval = setInterval(() => {
    for (const { git } of sessions.values()) {
      if (git.mode() === 'remote') git.fetch().catch((error) => {
        git.lastError = error.message; git.onStatus();
      });
    }
  }, 60000);
  interval.unref();
};

module.exports = { registerStudioIpc, managedFileSaved, validateStudioWrite, resolveForRequest };
