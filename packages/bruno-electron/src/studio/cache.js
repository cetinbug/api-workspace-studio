const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicJson } = require('./workspace');

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const VERIFIER = 'api-workspace-studio-cache-v1';

const encrypt = (key, value) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
};

const decrypt = (key, envelope) => {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
};

class SecretCache {
  constructor(directory) {
    this.filename = path.join(directory, 'cache.enc.json');
    this.key = null;
    this.payload = null;
    this.salt = null;
  }

  status() {
    return { enabled: fs.existsSync(this.filename), locked: !this.key, ttlMs: this.payload?.ttlMs || DEFAULT_TTL_MS };
  }

  derive(password, salt) {
    if (typeof password !== 'string' || password.length < 12) throw new Error('Cache password must be at least 12 characters');
    return crypto.scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  }

  enable(password, ttlMs = DEFAULT_TTL_MS) {
    if (fs.existsSync(this.filename)) throw new Error('Cache is already enabled');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60000) throw new Error('Invalid cache TTL');
    this.salt = crypto.randomBytes(32);
    this.key = this.derive(password, this.salt);
    this.payload = { ttlMs, entries: {}, localSecrets: {} };
    this.persist();
    return this.status();
  }

  unlock(password) {
    const envelope = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
    const salt = Buffer.from(envelope.salt, 'base64');
    const key = this.derive(password, salt);
    let verifier;
    try { verifier = decrypt(key, envelope.verifier); } catch { throw new Error('Wrong cache password or damaged cache verifier'); }
    if (verifier !== VERIFIER) throw new Error('Damaged cache verifier');
    let payload;
    try { payload = decrypt(key, envelope.payload); } catch { throw new Error('Encrypted cache is corrupted or tampered with'); }
    this.key = key;
    this.salt = salt;
    this.payload = payload;
    return this.status();
  }

  lock() {
    this.key = null;
    this.payload = null;
    this.salt = null;
    return this.status();
  }

  persist() {
    if (!this.key || !this.payload) throw new Error('Offline cache is locked');
    atomicJson(this.filename, {
      version: 1,
      kdf: 'scrypt',
      salt: this.salt.toString('base64'),
      verifier: encrypt(this.key, VERIFIER),
      payload: encrypt(this.key, this.payload)
    });
  }

  put(key, value, now = Date.now()) {
    if (!this.key) return false;
    this.payload.entries[key] = { value, fetchedAt: now };
    this.persist();
    return true;
  }

  get(key, now = Date.now()) {
    if (!fs.existsSync(this.filename)) throw new Error('Offline cache is disabled');
    if (!this.key) throw new Error('Offline cache is locked');
    const entry = this.payload.entries[key];
    if (!entry) throw new Error('No cached value for this secret');
    if (now - entry.fetchedAt > this.payload.ttlMs || now < entry.fetchedAt) throw new Error('Offline cache entry is expired');
    return entry;
  }

  putLocal(key, value) {
    if (!this.key) throw new Error('Enable and unlock encrypted cache before saving a local secret override');
    this.payload.localSecrets[key] = value;
    this.persist();
  }

  getLocal(key) {
    if (!this.key) throw new Error('Offline cache is locked');
    if (!Object.hasOwn(this.payload.localSecrets, key)) throw new Error('Local secret override is missing');
    return this.payload.localSecrets[key];
  }

  changePassword(oldPassword, newPassword) {
    this.lock();
    this.unlock(oldPassword);
    this.salt = crypto.randomBytes(32);
    this.key = this.derive(newPassword, this.salt);
    this.persist();
    return this.status();
  }

  reset() {
    this.lock();
    if (fs.existsSync(this.filename)) fs.unlinkSync(this.filename);
    return this.status();
  }
}

module.exports = { SecretCache, DEFAULT_TTL_MS };
