const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MANIFEST = path.join('.apiworkspace', 'manifest.json');

const findWorkspace = (startPath) => {
  let current = path.resolve(startPath);
  if (fs.existsSync(current) && fs.statSync(current).isFile()) current = path.dirname(current);
  while (true) {
    if (fs.existsSync(path.join(current, MANIFEST))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

const readManifest = (workspacePath) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(workspacePath, MANIFEST), 'utf8'));
  validateManifest(manifest);
  return manifest;
};

function validateManifest(manifest) {
  if (!manifest || manifest.version !== 1 || typeof manifest.providers !== 'object'
    || typeof manifest.secrets !== 'object' || typeof manifest.environments !== 'object') {
    throw new Error('Invalid API Workspace Studio manifest');
  }
  for (const [id, provider] of Object.entries(manifest.providers)) {
    if (!/^[a-zA-Z][\w.-]*$/.test(id) || provider.type !== 'mock'
      || Object.keys(provider).some((key) => !['type', 'name'].includes(key))) {
      throw new Error(`Invalid provider definition: ${id}`);
    }
  }
  for (const [id, secret] of Object.entries(manifest.secrets)) {
    if (!/^[a-zA-Z][\w.-]*$/.test(id) || !secret.name
      || Object.keys(secret).some((key) => !['name', 'description', 'tags'].includes(key))) {
      throw new Error(`Invalid logical secret: ${id}`);
    }
  }
  for (const [name, environment] of Object.entries(manifest.environments)) {
    if (!name || !environment || !manifest.providers[environment.defaultProvider]
      || typeof environment.bindings !== 'object' || typeof environment.secrets !== 'object') {
      throw new Error(`Invalid environment: ${name}`);
    }
    for (const [variable, secretId] of Object.entries(environment.bindings)) {
      if (!variable || !manifest.secrets[secretId]) throw new Error(`Invalid binding: ${variable}`);
    }
    for (const [variable, value] of Object.entries(environment.variables || {})) {
      if (/password|secret|token|api.?key|private.?key/i.test(variable) || typeof value !== 'string'
        || /-----BEGIN .*PRIVATE KEY-----|(?:ghp_|sk-)[A-Za-z0-9_-]{16,}/.test(value)) {
        throw new Error(`Shared variable may contain a secret: ${variable}`);
      }
    }
    for (const [secretId, mapping] of Object.entries(environment.secrets)) {
      if (!manifest.secrets[secretId] || !mapping.reference || typeof mapping.reference !== 'string'
        || (mapping.provider && !manifest.providers[mapping.provider])
        || Object.keys(mapping).some((key) => !['reference', 'provider'].includes(key))) {
        throw new Error(`Invalid secret mapping: ${secretId}`);
      }
    }
  }
  return manifest;
}

const saveManifest = (workspacePath, manifest) => {
  validateManifest(manifest);
  require('./git-sync').assertNoSecretContent(JSON.stringify(manifest));
  const filename = path.join(workspacePath, MANIFEST);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  atomicJson(filename, manifest);
  return filename;
};

function atomicJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temp = `${filename}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, filename);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

const userWorkspacePath = (userData, workspacePath) => {
  const id = crypto.createHash('sha256').update(path.resolve(workspacePath).toLowerCase()).digest('hex');
  return path.join(userData, 'api-workspace-studio', id);
};

module.exports = { MANIFEST, findWorkspace, readManifest, saveManifest, atomicJson, userWorkspacePath };
