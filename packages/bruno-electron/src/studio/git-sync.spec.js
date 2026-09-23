const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { GitSync } = require('./git-sync');
const { assertNoSecretContent } = require('./git-sync');

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true }).trim();

describe('API Workspace Studio Git sync', () => {
  let directory;
  let bare;
  let first;
  let second;
  let sync;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-git-'));
    bare = path.join(directory, 'remote.git');
    first = path.join(directory, 'first');
    second = path.join(directory, 'second');
    git(directory, 'init', '--bare', bare);
    fs.mkdirSync(first);
    git(first, 'init');
    git(first, 'config', 'user.name', 'Studio Test');
    git(first, 'config', 'user.email', 'studio@example.test');
    fs.writeFileSync(path.join(first, 'request.bru'), 'get { url: https://example.test }\n');
    git(first, 'add', '--', 'request.bru');
    git(first, 'commit', '-m', 'Initial request');
    git(first, 'branch', '-M', 'main');
    git(first, 'remote', 'add', 'origin', bare);
    git(first, 'push', '-u', 'origin', 'main');
    git(directory, 'clone', '-b', 'main', bare, second);
    git(second, 'config', 'user.name', 'Studio Test');
    git(second, 'config', 'user.email', 'studio@example.test');
    sync = new GitSync(first, directory);
  });

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  test('local mode saves without commit or push; remote mode scopes changes', async () => {
    const before = git(first, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(first, 'request.bru'), 'get { url: https://example.test/one }\n');
    sync.saved(path.join(first, 'request.bru'));
    expect(git(first, 'rev-parse', 'HEAD')).toBe(before);
    fs.writeFileSync(path.join(first, 'unmanaged.txt'), 'do not stage');
    sync.setMode('remote');
    sync.saved(path.join(first, 'request.bru'));
    await sync.sync();
    expect(git(first, 'rev-parse', 'HEAD')).not.toBe(before);
    expect(git(second, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(first, 'status', '--porcelain')).toContain('unmanaged.txt');
    git(second, 'pull', '--ff-only');
    expect(fs.readFileSync(path.join(second, 'request.bru'), 'utf8')).toContain('/one');
  });

  test('remote changes are detected and pull is explicit', async () => {
    fs.writeFileSync(path.join(second, 'request.bru'), 'get { url: https://example.test/two }\n');
    git(second, 'add', '--', 'request.bru');
    git(second, 'commit', '-m', 'Second clone edit');
    git(second, 'push');
    sync.setMode('remote');
    const status = await sync.fetch();
    expect(status.behind).toBe(1);
    expect(fs.readFileSync(path.join(first, 'request.bru'), 'utf8')).not.toContain('/two');
    await sync.pull();
    expect(fs.readFileSync(path.join(first, 'request.bru'), 'utf8')).toContain('/two');
  });

  test('conflict never overwrites either side', async () => {
    fs.writeFileSync(path.join(first, 'request.bru'), 'get { url: https://example.test/local }\n');
    sync.setMode('remote');
    sync.saved(path.join(first, 'request.bru'));
    fs.writeFileSync(path.join(second, 'request.bru'), 'get { url: https://example.test/remote }\n');
    git(second, 'add', '--', 'request.bru');
    git(second, 'commit', '-m', 'Remote edit');
    git(second, 'push');
    await expect(sync.sync()).rejects.toThrow(/conflict/);
    expect(fs.readFileSync(path.join(first, 'request.bru'), 'utf8')).toContain('/local');
    expect(fs.readFileSync(path.join(second, 'request.bru'), 'utf8')).toContain('/remote');
    await expect(sync.pull()).rejects.toThrow(/waiting to sync/);
  });

  test('secret-looking content prevents automatic commit', async () => {
    fs.writeFileSync(path.join(first, 'request.bru'), 'headers { api_key: abcdefghijklmnopqrstuvwxyz012345 }\n');
    sync.setMode('remote');
    sync.saved(path.join(first, 'request.bru'));
    await expect(sync.sync()).rejects.toThrow(/raw secret/);
  });

  test('save guard blocks literal bearer values but permits logical variables', () => {
    expect(() => assertNoSecretContent('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345')).toThrow(/raw secret/);
    expect(() => assertNoSecretContent('Authorization: Bearer {{apiKey}}')).not.toThrow();
  });

  test('known runtime secret is blocked even in an innocent-looking field', () => {
    sync.registerSecret('MOCK_KNOWN_VALUE');
    expect(() => sync.assertSafeContent('url: https://example.test/MOCK_KNOWN_VALUE'))
      .toThrow(/Known secret value/);
  });

  test('Save & Sync includes eligible local-mode edits but leaves unrelated files alone', async () => {
    fs.mkdirSync(path.join(first, '.apiworkspace'));
    fs.writeFileSync(path.join(first, '.apiworkspace', 'manifest.json'), '{"version":1}\n');
    fs.writeFileSync(path.join(first, 'unmanaged.txt'), 'local note');
    sync.setMode('remote');
    await sync.syncAllManaged();
    git(second, 'pull', '--ff-only');
    expect(fs.existsSync(path.join(second, '.apiworkspace', 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(second, 'unmanaged.txt'))).toBe(false);
  });

  test('managed deletion syncs without trying to read a removed file', async () => {
    fs.unlinkSync(path.join(first, 'request.bru'));
    sync.setMode('remote');
    await sync.syncAllManaged();
    git(second, 'pull', '--ff-only');
    expect(fs.existsSync(path.join(second, 'request.bru'))).toBe(false);
  });
});
