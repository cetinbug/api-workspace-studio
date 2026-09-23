const fs = require('fs');
const os = require('os');
const path = require('path');
const { saveManifest } = require('./workspace');
const { StudioSecrets, assertNoSecretShadowing } = require('./secrets');

describe('API Workspace Studio secret resolution', () => {
  let root;
  let userData;
  let studio;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-workspace-'));
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-userdata-'));
    saveManifest(root, {
      version: 1,
      providers: { shared: { type: 'mock', name: 'Shared Mock' } },
      secrets: { 'service.api-key': { name: 'Service API key' } },
      environments: {
        Test: { defaultProvider: 'shared', variables: { baseUrl: 'https://example.test' },
          bindings: { apiKey: 'service.api-key' }, secrets: { 'service.api-key': { reference: 'service-key' } } }
      }
    });
    fs.writeFileSync(path.join(root, 'List.bru'), 'get {\n  url: {{baseUrl}}/items\n}\nheaders {\n  x-api-key: {{apiKey}}\n}\n');
    studio = new StudioSecrets(root, userData);
    const local = studio.local();
    local.mockSecrets.shared = { 'service-key': 'MOCK_VALUE_DO_NOT_COMMIT' };
    studio.saveLocal(local);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  });

  test('request variables resolve via logical secret and provider; cache stays off by default', async () => {
    const result = await studio.resolve('Test');
    expect(result.variables.apiKey).toBe('MOCK_VALUE_DO_NOT_COMMIT');
    expect(result.sources.apiKey).toBe('mock');
    expect(studio.inspect('Test').whereUsed['service.api-key']).toEqual(['List.bru']);
    expect(studio.cache.status().enabled).toBe(false);
    expect(fs.readdirSync(studio.directory)).not.toContain('cache.enc.json');
    expect(fs.readFileSync(path.join(studio.directory, 'local.json'), 'utf8')).not.toContain('MOCK_VALUE_DO_NOT_COMMIT');
  });

  test('transient failure uses fresh encrypted cache but 403 does not', async () => {
    studio.cache.enable('a-strong-test-password');
    await studio.resolve('Test');
    const encrypted = fs.readFileSync(studio.cache.filename, 'utf8');
    expect(encrypted).not.toContain('MOCK_VALUE_DO_NOT_COMMIT');
    expect(encrypted).not.toContain('a-strong-test-password');
    const local = studio.local();
    local.simulations.shared = { failure: 'network' };
    studio.saveLocal(local);
    const cached = await studio.resolve('Test');
    expect(cached.variables.apiKey).toBe('MOCK_VALUE_DO_NOT_COMMIT');
    expect(cached.sources.apiKey).toMatch(/^cached/);
    local.simulations.shared = { failure: '403' };
    studio.saveLocal(local);
    await expect(studio.resolve('Test')).rejects.toMatchObject({ code: '403' });
  });

  test('cache lock, wrong password, TTL and tampering fail closed', async () => {
    studio.cache.enable('a-strong-test-password', 60000);
    await studio.resolve('Test');
    studio.cache.lock();
    expect(() => studio.cache.unlock('wrong-password-123')).toThrow(/Wrong cache password/);
    studio.cache.unlock('a-strong-test-password');
    const key = JSON.stringify(['Test', 'shared', 'service-key']);
    expect(() => studio.cache.get(key, Date.now() + 61000)).toThrow(/expired/);
    const envelope = JSON.parse(fs.readFileSync(studio.cache.filename, 'utf8'));
    envelope.payload.data = Buffer.from('tampered').toString('base64');
    fs.writeFileSync(studio.cache.filename, JSON.stringify(envelope));
    studio.cache.lock();
    expect(() => studio.cache.unlock('a-strong-test-password')).toThrow(/corrupted or tampered/);
  });

  test('local secret override is encrypted and source choice is explicit', async () => {
    studio.cache.enable('a-strong-test-password');
    const key = JSON.stringify(['Test', 'shared', 'service-key']);
    studio.cache.putLocal(key, 'LOCAL_ONLY_VALUE');
    const local = studio.local();
    local.sources.Test = { apiKey: 'local' };
    studio.saveLocal(local);
    expect((await studio.resolve('Test')).variables.apiKey).toBe('LOCAL_ONLY_VALUE');
    expect(fs.readFileSync(studio.cache.filename, 'utf8')).not.toContain('LOCAL_ONLY_VALUE');
    studio.cache.lock();
    await expect(studio.resolve('Test')).rejects.toThrow(/locked/);
  });

  test('401 and missing secret never fall back to the cache', async () => {
    studio.cache.enable('a-strong-test-password');
    await studio.resolve('Test');
    const local = studio.local();
    local.simulations.shared = { failure: '401' };
    studio.saveLocal(local);
    await expect(studio.resolve('Test')).rejects.toMatchObject({ code: '401' });
    local.simulations.shared = { failure: '404' };
    studio.saveLocal(local);
    await expect(studio.resolve('Test')).rejects.toMatchObject({ code: '404' });
  });

  test('password change preserves entries without writing either password', async () => {
    studio.cache.enable('a-strong-test-password');
    await studio.resolve('Test');
    studio.cache.changePassword('a-strong-test-password', 'another-strong-password');
    studio.cache.lock();
    expect(() => studio.cache.unlock('a-strong-test-password')).toThrow(/Wrong cache password/);
    studio.cache.unlock('another-strong-password');
    expect(studio.cache.get(JSON.stringify(['Test', 'shared', 'service-key'])).value).toBe('MOCK_VALUE_DO_NOT_COMMIT');
    const encrypted = fs.readFileSync(studio.cache.filename, 'utf8');
    expect(encrypted).not.toContain('another-strong-password');
  });

  test('duplicate logical definitions are detected by provider and physical reference', () => {
    const manifest = studio.inspect('Test').manifest;
    manifest.secrets['duplicate.key'] = { name: 'Duplicate key' };
    manifest.environments.Test.secrets['duplicate.key'] = { reference: 'service-key', provider: 'shared' };
    saveManifest(root, manifest);
    expect(studio.inspect('Test').duplicates).toEqual([{
      first: 'service.api-key', second: 'duplicate.key', environment: 'Test'
    }]);
  });

  test('request or runtime variables cannot silently shadow logical secrets', () => {
    expect(() => assertNoSecretShadowing({ requestVariables: { apiKey: 'override' } }, {}, ['apiKey']))
      .toThrow(/also defined/);
    expect(() => assertNoSecretShadowing({}, { apiKey: 'override' }, ['apiKey']))
      .toThrow(/also defined/);
    expect(() => assertNoSecretShadowing({ requestVariables: { other: 'value' } }, {}, ['apiKey']))
      .not.toThrow();
  });
});
