const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { atomicJson, userWorkspacePath } = require('./workspace');

const execFileAsync = promisify(execFile);
const MANAGED = /(?:\.bru|\.yml|\.yaml|\.md|\.js|\.ts|\.json|\.graphql|\.proto|\.txt)$/i;
const SENSITIVE = /(?:api[_-]?key|client[_-]?secret|password|access[_-]?token|refresh[_-]?token|private[_-]?key)\s*[=:]\s*["']?(?!\s*(?:\{\{|\$\{|<|REPLACE_ME|placeholder|reference|ref\b))[A-Za-z0-9_+/.=-]{12,}/i;
const assertNoSecretContent = (content) => {
  if (SENSITIVE.test(content) || /(?:authorization\s*:\s*)?bearer\s+(?!\{\{)[A-Za-z0-9._~+/-]{16,}/i.test(content)
    || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) {
    throw new Error('Possible raw secret found in managed file; save and commit stopped');
  }
};

class GitSync {
  constructor(workspacePath, userData, onStatus = () => {}) {
    this.workspacePath = path.resolve(workspacePath);
    this.settingsFile = path.join(userWorkspacePath(userData, workspacePath), 'sync.json');
    this.pending = new Map();
    this.timer = null;
    this.syncPromise = null;
    this.onStatus = onStatus;
    this.lastError = null;
    this.remoteChanges = false;
    this.knownSecrets = new Set();
  }

  async git(...args) {
    try {
      const { stdout } = await execFileAsync('git', ['-C', this.workspacePath, ...args], {
        timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true
      });
      return args.includes('-z') ? stdout : stdout.trim();
    } catch (error) {
      const stderr = String(error.stderr || '');
      if (/authentication|permission denied|could not read username|publickey/i.test(stderr)) throw new Error('Git authentication failed');
      if (/could not resolve|unable to access|timed out|connection refused/i.test(stderr)) throw new Error('Git remote unavailable');
      throw new Error('Git operation failed; inspect repository status in your Git client');
    }
  }

  mode() {
    return fs.existsSync(this.settingsFile) ? JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')).mode : 'local';
  }

  setMode(mode) {
    if (!['local', 'remote'].includes(mode)) throw new Error('Invalid Git mode');
    atomicJson(this.settingsFile, { mode });
    if (mode === 'local' && this.timer) clearTimeout(this.timer);
    if (mode === 'remote' && this.pending.size) this.schedule();
    return mode;
  }

  managed(file) {
    const relative = path.relative(this.workspacePath, path.resolve(file)).replace(/\\/g, '/');
    if (!relative || relative.startsWith('../') || path.isAbsolute(relative)
      || relative.split('/').some((segment) => segment === '.git' || segment === 'node_modules')
      || relative.startsWith('.apiworkspace/') && relative !== '.apiworkspace/manifest.json') {
      throw new Error('File is outside the managed workspace');
    }
    if (!MANAGED.test(relative) && relative !== '.apiworkspace/manifest.json' && !/(^|\/)bruno\.json$/i.test(relative)) {
      throw new Error('File type is not managed by API Workspace Studio');
    }
    return relative;
  }

  scan(file) {
    if (!fs.existsSync(file)) return; // A managed deletion has no content to scan.
    const content = fs.readFileSync(file, 'utf8');
    this.assertSafeContent(content);
  }

  registerSecret(value) {
    if (typeof value === 'string' && value.length) this.knownSecrets.add(value);
  }

  assertSafeContent(content) {
    assertNoSecretContent(content);
    for (const value of this.knownSecrets) {
      if (content.includes(value)) throw new Error('Known secret value found in managed file; save and commit stopped');
    }
  }

  saved(file) {
    if (this.mode() !== 'remote') return;
    const relative = this.managed(file);
    this.pending.set(relative, (this.pending.get(relative) || 0) + 1);
    this.schedule();
  }

  schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.sync().catch((error) => {
        this.lastError = error.message;
        this.onStatus();
      });
    }, 1500);
  }

  async branch() {
    const branch = await this.git('branch', '--show-current');
    if (!branch) throw new Error('Git branch is detached');
    return branch;
  }

  async fetch() {
    const branch = await this.branch();
    await this.git('fetch', 'origin', branch);
    const [ahead, behind] = (await this.git('rev-list', '--left-right', '--count', 'HEAD...FETCH_HEAD')).split(/\s+/).map(Number);
    this.remoteChanges = behind > 0;
    this.onStatus();
    return { branch, ahead, behind };
  }

  async status() {
    let branch = null;
    try { branch = await this.branch(); } catch { /* A workspace need not be a Git repository. */ }
    return { mode: this.mode(), branch, pending: this.pending.size, remoteChanges: this.remoteChanges,
      error: this.lastError };
  }

  async sync() {
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.syncQueued();
    try { return await this.syncPromise; } finally { this.syncPromise = null; }
  }

  async syncAllManaged() {
    if (this.mode() !== 'remote') throw new Error('Enable Remote Sync mode first');
    const entries = (await this.git('status', '--porcelain=v1', '-z', '--untracked-files=all')).split('\0');
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (!entry) continue;
      const flags = entry.slice(0, 2);
      const relative = entry.slice(3);
      if (flags.includes('R') || flags.includes('C')) index++; // Git adds the old path as a second NUL record.
      if (!/^(?:\.apiworkspace\/manifest\.json|workspace\.yml)$/i.test(relative)
        && !/(?:^|\/)bruno\.json$/i.test(relative)
        && !/\.bru$/i.test(relative)
        && !/^(?:collections|requests|environments|scripts|tests|docs)\//i.test(relative)) continue;
      try {
        this.managed(path.join(this.workspacePath, relative));
        this.pending.set(relative, (this.pending.get(relative) || 0) + 1);
      } catch { /* Unmanaged files are never staged automatically. */ }
    }
    return this.sync();
  }

  async syncQueued() {
    if (this.mode() !== 'remote') return this.status();
    if (this.timer) {
      clearTimeout(this.timer); this.timer = null;
    }
    const queued = [...this.pending.entries()];
    const files = queued.map(([file]) => file);
    if (!files.length) return this.status();
    try {
      const { branch, behind } = await this.fetch();
      if (behind) throw new Error('Remote changes conflict with local work; pull or resolve before pushing');
      const staged = (await this.git('diff', '--cached', '--name-only')).split(/\r?\n/).filter(Boolean);
      if (staged.some((file) => !this.pending.has(file))) throw new Error('Existing staged Git changes need review before automatic sync');
      for (const relative of files) this.scan(path.join(this.workspacePath, relative));
      await this.git('add', '-A', '--', ...files);
      const stagedFiles = (await this.git('diff', '--cached', '--name-only')).split(/\r?\n/).filter(Boolean);
      if (stagedFiles.some((file) => !this.pending.has(file))) throw new Error('Unexpected staged file; sync stopped');
      if (stagedFiles.length) await this.git('commit', '-m', 'Update API workspace definitions');
      await this.git('push', 'origin', branch);
      queued.forEach(([file, revision]) => {
        if (this.pending.get(file) === revision) this.pending.delete(file);
      });
      if (this.pending.size) this.schedule();
      this.lastError = null;
    } catch (error) {
      this.lastError = error.message;
      throw error;
    } finally {
      this.onStatus();
    }
    return this.status();
  }

  async pull() {
    if (this.pending.size) throw new Error('Saved changes are waiting to sync; resolve them before pulling');
    const dirty = await this.git('status', '--porcelain');
    if (dirty) throw new Error('Save or resolve local changes before pulling');
    const { behind, ahead } = await this.fetch();
    if (behind && ahead) throw new Error('Remote changes conflict with local commits; resolve in Git before pulling');
    if (behind) await this.git('merge', '--ff-only', 'FETCH_HEAD');
    this.remoteChanges = false;
    this.lastError = null;
    this.onStatus();
    return this.status();
  }
}

module.exports = { GitSync, assertNoSecretContent };
