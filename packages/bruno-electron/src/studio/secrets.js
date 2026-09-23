const fs = require('fs');
const path = require('path');
const { SecretCache } = require('./cache');
const { readManifest, atomicJson, userWorkspacePath } = require('./workspace');

const TRANSIENT = new Set(['network', 'timeout', 'unavailable']);

class ProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class MockSecretProvider {
  constructor(providerId, localData) {
    this.providerId = providerId;
    this.localData = localData;
  }

  async getSecret(reference) {
    const simulation = this.localData.simulations?.[this.providerId] || {};
    if (simulation.latencyMs) await new Promise((resolve) => setTimeout(resolve, simulation.latencyMs));
    const failure = simulation.failure;
    if (failure === 'network' || failure === 'timeout' || failure === 'unavailable') {
      throw new ProviderError(failure, `Mock secret provider ${failure}`);
    }
    if (failure === '401') throw new ProviderError('401', 'Secret provider unauthorized');
    if (failure === '403') throw new ProviderError('403', 'Secret provider forbidden');
    if (failure === '404') throw new ProviderError('404', 'Secret missing');
    const value = this.localData.mockSecrets?.[this.providerId]?.[reference];
    if (typeof value !== 'string') throw new ProviderError('404', 'Secret missing');
    return { value, source: 'mock' };
  }

  async getSecrets(references) {
    return Promise.all(references.map((reference) => this.getSecret(reference)));
  }

  async getStatus() {
    return { type: 'mock', failure: this.localData.simulations?.[this.providerId]?.failure || null };
  }
}

class StudioSecrets {
  constructor(workspacePath, userData) {
    this.workspacePath = workspacePath;
    this.directory = userWorkspacePath(userData, workspacePath);
    this.localFile = path.join(this.directory, 'local.json');
    this.mockFile = path.join(this.directory, 'mock-source.json');
    this.cache = new SecretCache(this.directory);
    this.lastSources = {};
    this.onResolvedSecret = () => {};
  }

  local() {
    const local = fs.existsSync(this.localFile)
      ? JSON.parse(fs.readFileSync(this.localFile, 'utf8'))
      : { version: 1, sources: {}, variables: {}, simulations: {} };
    return { ...local, mockSecrets: fs.existsSync(this.mockFile)
      ? JSON.parse(fs.readFileSync(this.mockFile, 'utf8')) : {} };
  }

  saveLocal(data) {
    const allowed = ['version', 'sources', 'variables', 'mockSecrets', 'simulations'];
    if (!data || data.version !== 1 || Object.keys(data).some((key) => !allowed.includes(key))) {
      throw new Error('Invalid local workspace data');
    }
    const { mockSecrets, ...preferences } = data;
    atomicJson(this.localFile, preferences);
    if (mockSecrets && Object.keys(mockSecrets).length) atomicJson(this.mockFile, mockSecrets);
  }

  provider(manifest, id, localData) {
    const config = manifest.providers[id];
    if (!config) throw new Error(`Unknown secret provider: ${id}`);
    if (config.type === 'mock') return new MockSecretProvider(id, localData);
    throw new Error(`Unsupported secret provider type: ${config.type}`);
  }

  inspect(environmentName) {
    const manifest = readManifest(this.workspacePath);
    const environment = manifest.environments[environmentName];
    if (!environment) throw new Error(`Environment not configured: ${environmentName}`);
    const use = {};
    for (const [variable, secretId] of Object.entries(environment.bindings)) {
      (use[secretId] ||= []).push(variable);
    }
    const whereUsed = {};
    const visit = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && !['.git', 'node_modules', '.apiworkspace'].includes(entry.name)) visit(path.join(directory, entry.name));
        else if (entry.isFile() && entry.name.endsWith('.bru')) {
          const filename = path.join(directory, entry.name);
          const content = fs.readFileSync(filename, 'utf8');
          for (const [secretId, variables] of Object.entries(use)) {
            if (variables.some((variable) => content.includes(`{{${variable}}}`))) {
              (whereUsed[secretId] ||= []).push(path.relative(this.workspacePath, filename));
            }
          }
        }
      }
    };
    visit(this.workspacePath);
    const duplicates = [];
    const seen = new Map();
    for (const [name, env] of Object.entries(manifest.environments)) {
      for (const [secretId, mapping] of Object.entries(env.secrets)) {
        const pair = `${mapping.provider || env.defaultProvider}:${mapping.reference}`;
        if (seen.has(pair) && seen.get(pair) !== secretId) duplicates.push({ first: seen.get(pair), second: secretId, environment: name });
        else seen.set(pair, secretId);
      }
    }
    return { manifest, environment, whereUsed, duplicates, cache: this.cache.status(),
      sources: this.lastSources, choices: this.local().sources?.[environmentName] || {},
      simulations: this.local().simulations || {} };
  }

  async resolve(environmentName, baseVariables = {}) {
    const { manifest, environment } = this.inspect(environmentName);
    const localData = this.local();
    const variables = { ...baseVariables, ...environment.variables };
    const sources = {};
    this.lastSources = {};
    for (const [variable, value] of Object.entries(localData.variables?.[environmentName] || {})) {
      if (localData.sources?.[environmentName]?.[variable] === 'local') variables[variable] = value;
    }
    for (const [variable, secretId] of Object.entries(environment.bindings)) {
      const mapping = environment.secrets[secretId];
      if (!mapping) throw new Error(`Secret mapping missing: ${secretId}`);
      const providerId = mapping.provider || environment.defaultProvider;
      const cacheKey = JSON.stringify([environmentName, providerId, mapping.reference]);
      const choice = localData.sources?.[environmentName]?.[variable] || 'remote';
      if (choice === 'local') {
        variables[variable] = this.cache.getLocal(cacheKey);
        this.onResolvedSecret(variables[variable]);
        sources[variable] = 'local override';
        continue;
      }
      try {
        const result = await this.provider(manifest, providerId, localData).getSecret(mapping.reference);
        variables[variable] = result.value;
        this.onResolvedSecret(result.value);
        sources[variable] = result.source;
        this.cache.put(cacheKey, result.value);
      } catch (error) {
        if (!TRANSIENT.has(error.code)) {
          this.lastSources = { ...sources, [variable]: error.message };
          throw error;
        }
        try {
          const cached = this.cache.get(cacheKey);
          variables[variable] = cached.value;
          this.onResolvedSecret(cached.value);
          sources[variable] = `cached (${new Date(cached.fetchedAt).toISOString()})`;
        } catch (cacheError) {
          this.lastSources = { ...sources, [variable]: `${error.message}; ${cacheError.message}` };
          throw new Error(`${error.message}; ${cacheError.message}`);
        }
      }
    }
    this.lastSources = sources;
    return { variables, sources };
  }
}

const assertNoSecretShadowing = (request, runtimeVariables, names) => {
  for (const name of names) {
    if ([request.collectionVariables, request.folderVariables, request.requestVariables, runtimeVariables]
      .some((variables) => variables && Object.hasOwn(variables, name))) {
      throw new Error(`Logical secret variable ${name} is also defined in a request, collection, folder or runtime scope`);
    }
  }
};

module.exports = { StudioSecrets, MockSecretProvider, ProviderError, assertNoSecretShadowing };
