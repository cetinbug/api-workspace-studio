import React, { useCallback, useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import toast from 'react-hot-toast';
import { switchWorkspace } from 'providers/ReduxStore/slices/workspaces/actions';
import { flattenItems, hasRequestChanges } from 'utils/collections';

const row = { display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0', flexWrap: 'wrap' };
const input = { padding: 6, border: '1px solid #888', borderRadius: 4, color: '#111', background: '#fff' };
const button = { padding: '5px 9px', border: '1px solid #888', borderRadius: 4, cursor: 'pointer' };

const StudioPanel = ({ workspace, activeEnvironment }) => {
  const dispatch = useDispatch();
  const collections = useSelector((state) => state.collections?.collections || []);
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [environmentName, setEnvironmentName] = useState(activeEnvironment || '');
  const [secretId, setSecretId] = useState('');
  const [secretName, setSecretName] = useState('');
  const [variable, setVariable] = useState('');
  const [reference, setReference] = useState('');
  const [providerId, setProviderId] = useState('');
  const [mockValue, setMockValue] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [ttlDays, setTtlDays] = useState(7);
  const [localValue, setLocalValue] = useState('');
  const [selectedVariable, setSelectedVariable] = useState('');
  const [newEnvironment, setNewEnvironment] = useState('');
  const [newProvider, setNewProvider] = useState('');
  const [latencyMs, setLatencyMs] = useState(0);
  const [plainName, setPlainName] = useState('');
  const [plainValue, setPlainValue] = useState('');

  const call = useCallback((channel, ...args) => window.ipcRenderer.invoke(channel, workspace.pathname, ...args), [workspace?.pathname]);
  const refresh = useCallback(async () => {
    const result = await call('studio:get', environmentName || activeEnvironment);
    setData(result);
    if (result.environmentName && !result.manifest?.environments?.[environmentName]) setEnvironmentName(result.environmentName);
  }, [call, environmentName, activeEnvironment]);

  useEffect(() => {
    if (activeEnvironment && data?.manifest?.environments?.[activeEnvironment]) setEnvironmentName(activeEnvironment);
  }, [activeEnvironment, data?.manifest]);

  useEffect(() => { refresh().catch((error) => toast.error(error.message)); }, [refresh]);
  useEffect(() => {
    const off = window.ipcRenderer.on('main:studio-git-status', (root) => {
      if (root === data?.root) refresh().catch(() => {});
    });
    const offSecrets = window.ipcRenderer.on('main:studio-secret-sources', (root) => {
      if (root === data?.root) refresh().catch(() => {});
    });
    return () => {
      off?.(); offSecrets?.();
    };
  }, [data?.root, refresh]);

  const run = async (work, success) => {
    try {
      await work();
      await refresh();
      if (success) toast.success(success);
    } catch (error) { toast.error(error.message || 'Operation failed'); }
  };

  const updateManifest = (change) => run(async () => {
    const manifest = JSON.parse(JSON.stringify(data.manifest));
    change(manifest);
    await call('studio:save-manifest', manifest);
  }, 'Workspace metadata saved');

  if (!workspace?.pathname) return null;
  const manifest = data?.manifest;
  const environment = manifest?.environments?.[environmentName];
  const bindings = Object.entries(environment?.bindings || {});
  const mockProvider = providerId || environment?.defaultProvider;
  const hasUnsavedChanges = collections.some((collection) => {
    if (!collection.pathname?.toLowerCase().startsWith(`${workspace.pathname.toLowerCase()}\\`)
      && !collection.pathname?.toLowerCase().startsWith(`${workspace.pathname.toLowerCase()}/`)) return false;
    return Boolean(collection.draft || collection.environmentsDraft)
      || flattenItems(collection.items || []).some((item) => Boolean(item.draft) || hasRequestChanges(item));
  });

  return (
    <>
      <button type="button" style={button} onClick={() => setOpen(true)} title="API Workspace Studio controls">
        Studio · {data?.git?.mode === 'remote' ? 'Remote Sync' : 'Local'}{data?.git?.remoteChanges ? ' · Updates' : ''}{data?.git?.error ? ' · Error' : ''}
      </button>
      {open && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 20000, background: '#0009', display: 'flex', justifyContent: 'center', alignItems: 'center', WebkitAppRegion: 'no-drag' }}>
          <div role="dialog" aria-label="API Workspace Studio" style={{ width: 760, maxHeight: '85vh', overflowY: 'auto', padding: 20, borderRadius: 8, background: '#f7f7f7', color: '#111', boxShadow: '0 8px 35px #0008' }}>
            <div style={{ ...row, justifyContent: 'space-between' }}><h2 style={{ margin: 0 }}>API Workspace Studio</h2><button style={button} onClick={() => setOpen(false)}>Close</button></div>
            {!data?.initialized ? (
              <div style={row}>
                <span>Initialize this workspace with a local Mock Secret Provider.</span>
                <button style={button} onClick={() => run(() => call('studio:init', activeEnvironment || 'Default'), 'Workspace initialized')}>Initialize</button>
              </div>
            ) : (
              <>
                <div style={row}>
                  <strong>Environment</strong>
                  <select
                    style={input}
                    value={environmentName}
                    onChange={(e) => {
                      setEnvironmentName(e.target.value); setProviderId('');
                    }}
                  >
                    {Object.keys(manifest.environments).map((name) => <option key={name}>{name}</option>)}
                  </select>
                  <span>Request environment: {activeEnvironment || 'none selected'}</span>
                </div>
                {activeEnvironment && !manifest.environments[activeEnvironment] && <p style={{ color: '#9a1212' }}>The active Bruno environment is not mapped in Studio. Add an environment with the same name before sending requests.</p>}
                <div style={row}>
                  <input style={input} placeholder="New environment name" value={newEnvironment} onChange={(e) => setNewEnvironment(e.target.value)} />
                  <button
                    style={button}
                    onClick={() => updateManifest((m) => {
                      if (!newEnvironment.trim() || m.environments[newEnvironment.trim()]) throw new Error('Choose a unique environment name');
                      m.environments[newEnvironment.trim()] = { defaultProvider: Object.keys(m.providers)[0], variables: {}, bindings: {}, secrets: {} };
                      setEnvironmentName(newEnvironment.trim()); setNewEnvironment('');
                    })}
                  >Add environment
                  </button>
                </div>
                <h3>Providers and logical secrets</h3>
                <div style={row}>
                  <input style={input} placeholder="Provider ID" value={newProvider} onChange={(e) => setNewProvider(e.target.value)} />
                  <button
                    style={button}
                    onClick={() => updateManifest((m) => {
                      if (!/^[a-zA-Z][\w.-]*$/.test(newProvider) || m.providers[newProvider]) throw new Error('Choose a unique provider ID');
                      m.providers[newProvider] = { type: 'mock', name: newProvider }; setNewProvider('');
                    })}
                  >Add Mock provider
                  </button>
                  <select style={input} value={environment?.defaultProvider || ''} onChange={(e) => updateManifest((m) => { m.environments[environmentName].defaultProvider = e.target.value; })}>
                    {Object.keys(manifest.providers).map((id) => <option key={id} value={id}>{id}</option>)}
                  </select><span>Default provider</span>
                </div>
                <div style={row}>
                  <input style={input} placeholder="Logical ID (e.g. service.api-key)" value={secretId} onChange={(e) => setSecretId(e.target.value)} />
                  <input style={input} placeholder="Display name" value={secretName} onChange={(e) => setSecretName(e.target.value)} />
                  <button
                    style={button}
                    onClick={() => updateManifest((m) => {
                      if (!/^[a-zA-Z][\w.-]*$/.test(secretId) || m.secrets[secretId] || !secretName.trim()) throw new Error('Choose a unique logical ID and display name');
                      m.secrets[secretId] = { name: secretName.trim() }; setSecretName('');
                    })}
                  >Add secret definition
                  </button>
                </div>
                <div style={row}>
                  <select style={input} value={secretId} onChange={(e) => setSecretId(e.target.value)}>
                    <option value="">Select logical secret</option>{Object.entries(manifest.secrets).map(([id, secret]) => <option key={id} value={id}>{secret.name} ({id})</option>)}
                  </select>
                  <input style={input} placeholder="Variable in request" value={variable} onChange={(e) => setVariable(e.target.value)} />
                  <input style={input} placeholder="Physical reference" value={reference} onChange={(e) => setReference(e.target.value)} />
                  <select style={input} value={mockProvider || ''} onChange={(e) => setProviderId(e.target.value)}>
                    {Object.keys(manifest.providers).map((id) => <option key={id}>{id}</option>)}
                  </select>
                  <button
                    style={button}
                    onClick={() => updateManifest((m) => {
                      if (!secretId || !variable.trim() || !reference.trim()) throw new Error('Secret, variable and reference are required');
                      const env = m.environments[environmentName];
                      env.bindings[variable.trim()] = secretId;
                      env.secrets[secretId] = { reference: reference.trim(), provider: mockProvider };
                    })}
                  >Map secret
                  </button>
                </div>
                <div style={row}>
                  <input type="password" style={input} placeholder="Mock secret value (never shown)" value={mockValue} onChange={(e) => setMockValue(e.target.value)} />
                  <button
                    style={button}
                    onClick={() => run(async () => {
                      if (!mockProvider || !reference) throw new Error('Select a provider and physical reference');
                      await call('studio:set-mock', mockProvider, reference, mockValue); setMockValue('');
                    }, 'Mock value saved outside Git')}
                  >Save mock value
                  </button>
                  <select style={input} onChange={(e) => run(() => call('studio:set-simulation', mockProvider, e.target.value || null, latencyMs), 'Simulation updated')} value={data.simulations?.[mockProvider]?.failure || ''}>
                    <option value="">Provider available</option><option value="network">Network unavailable</option><option value="timeout">Timeout</option><option value="401">401 Unauthorized</option><option value="403">403 Forbidden</option><option value="404">404 Missing</option>
                  </select>
                  <input type="number" min="0" max="10000" style={{ ...input, width: 86 }} value={latencyMs} onChange={(e) => setLatencyMs(Number(e.target.value))} title="Mock latency in milliseconds" />
                  <button style={button} onClick={() => run(() => call('studio:set-simulation', mockProvider, data.simulations?.[mockProvider]?.failure || null, latencyMs), 'Mock latency saved')}>Save latency</button>
                </div>
                <h3>Bindings and local choices</h3>
                <button style={button} onClick={() => run(() => call('studio:check-secrets', environmentName), 'Secrets checked')}>Check secrets</button>
                {bindings.length ? bindings.map(([name, id]) => (
                  <div style={row} key={name}>
                    <code>{name}</code><span>→</span><code>{id}</code><span>→</span><code>{environment.secrets[id]?.provider || environment.defaultProvider}:{environment.secrets[id]?.reference}</code>
                    <span>{data.sources?.[name] || 'not fetched'}</span>
                    <select style={input} onChange={(e) => run(() => call('studio:set-source', environmentName, name, e.target.value), 'Source choice saved')} value={data.choices?.[name] || 'remote'}>
                      <option value="remote">Provider</option><option value="local">Local override</option>
                    </select>
                    <button style={button} onClick={() => setSelectedVariable(name)}>Set local value</button>
                    <button
                      style={button}
                      onClick={() => {
                        setSecretId(id); setVariable(name); setReference(environment.secrets[id]?.reference || '');
                        setProviderId(environment.secrets[id]?.provider || environment.defaultProvider);
                      }}
                    >Use mapping above
                    </button>
                    <small>Requests: {(data.whereUsed?.[id] || []).join(', ') || 'none found'}</small>
                  </div>
                )) : <p>No bindings yet. Requests use variables such as <code>{'{{apiKey}}'}</code>.</p>}
                {selectedVariable && (
                  <div style={row}>
                    <span>Local override for {selectedVariable}</span>
                    <input type="password" style={input} value={localValue} onChange={(e) => setLocalValue(e.target.value)} />
                    <button
                      style={button}
                      onClick={() => run(async () => {
                        await call('studio:set-local-secret', environmentName, selectedVariable, localValue);
                        await call('studio:set-source', environmentName, selectedVariable, 'local');
                        setLocalValue(''); setSelectedVariable('');
                      }, 'Encrypted local override saved')}
                    >Save encrypted override
                    </button>
                  </div>
                )}
                <h3>Non-secret variables</h3>
                <div style={row}>
                  <input style={input} placeholder="Variable name" value={plainName} onChange={(e) => setPlainName(e.target.value)} />
                  <input style={input} placeholder="Non-secret value" value={plainValue} onChange={(e) => setPlainValue(e.target.value)} />
                  <button
                    style={button}
                    onClick={() => updateManifest((m) => {
                      if (!plainName.trim() || m.environments[environmentName].bindings[plainName]) throw new Error('Choose a non-secret variable name');
                      m.environments[environmentName].variables[plainName.trim()] = plainValue;
                      setPlainValue('');
                    })}
                  >Save shared value
                  </button>
                  <button
                    style={button}
                    onClick={() => run(async () => {
                      await call('studio:set-variable', environmentName, plainName, plainValue);
                      await call('studio:set-source', environmentName, plainName, 'local');
                      setPlainValue('');
                    }, 'Local value saved')}
                  >Save local value
                  </button>
                </div>
                {Object.entries(environment?.variables || {}).map(([name, value]) => (
                  <div style={row} key={name}>
                    <code>{name}</code><span>Shared: {value}</span>
                    <select style={input} value={data.choices?.[name] || 'remote'} onChange={(e) => run(() => call('studio:set-source', environmentName, name, e.target.value), 'Source choice saved')}>
                      <option value="remote">Shared</option><option value="local">Local override</option>
                    </select>
                  </div>
                ))}
                {data.duplicates?.length > 0 && <p>Possible duplicate references: {data.duplicates.map((d) => `${d.first} / ${d.second}`).join(', ')}</p>}
                <h3>Encrypted offline cache</h3>
                <div style={row}>
                  <span>{data.cache?.enabled ? data.cache.locked ? 'Enabled · Locked' : 'Enabled · Unlocked' : 'Disabled (default)'}</span>
                  <input type="password" style={input} placeholder="Password (12+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} />
                  {!data.cache?.enabled && (
                    <><input type="password" style={input} placeholder="Confirm password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
                      <input type="number" min="1" max="365" style={{ ...input, width: 64 }} value={ttlDays} onChange={(e) => setTtlDays(Number(e.target.value))} title="Cache lifetime in days" /><span>days</span>
                      <button
                        style={button}
                        onClick={() => run(async () => {
                          if (password !== confirmPassword) throw new Error('Cache passwords do not match');
                          await call('studio:cache', 'enable', { password, ttlMs: ttlDays * 86400000 });
                          setPassword(''); setConfirmPassword('');
                        }, 'Encrypted cache enabled')}
                      >Enable
                      </button>
                    </>
                  )}
                  {data.cache?.enabled && data.cache.locked && (
                    <button
                      style={button}
                      onClick={() => run(async () => {
                        await call('studio:cache', 'unlock', { password }); setPassword('');
                      }, 'Cache unlocked')}
                    >Unlock
                    </button>
                  )}
                  {data.cache?.enabled && !data.cache.locked && <button style={button} onClick={() => run(() => call('studio:cache', 'lock'), 'Cache locked')}>Lock</button>}
                  {data.cache?.enabled && (
                    <><input type="password" style={input} placeholder="New password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
                      <button
                        style={button}
                        onClick={() => run(async () => {
                          await call('studio:cache', 'change-password', { oldPassword: password, newPassword }); setPassword(''); setNewPassword('');
                        }, 'Cache password changed')}
                      >Change password
                      </button>
                    </>
                  )}
                  {data.cache?.enabled && <button style={button} onClick={() => { if (window.confirm('Permanently delete the encrypted cache and local secret overrides?')) run(() => call('studio:cache', 'reset'), 'Cache reset'); }}>Reset</button>}
                </div>
                <h3>Git sync</h3>
                <div style={row}>
                  <span>Branch: {data.git?.branch || 'No Git repository'}</span>
                  <select style={input} value={data.git?.mode || 'local'} onChange={(e) => run(() => call('studio:git', 'mode', e.target.value), 'Mode changed')}>
                    <option value="local">Local</option><option value="remote">Remote Sync</option>
                  </select>
                  <button style={button} onClick={() => run(() => call('studio:git', 'fetch'), 'Remote checked')}>Check remote</button>
                  <button
                    style={button}
                    onClick={() => run(async () => {
                      if (hasUnsavedChanges) throw new Error('Save or discard open editor changes before pulling');
                      await call('studio:git', 'pull'); await dispatch(switchWorkspace(workspace.uid));
                    }, 'Workspace updated')}
                  >Pull changes
                  </button>
                  <button style={button} onClick={() => run(() => call('studio:git', 'sync-all'), 'Managed changes synced')}>Save &amp; Sync</button>
                </div>
                {data.git?.remoteChanges && <p>Remote changes available. Pull to update the workspace.</p>}
                {data.git?.error && <p style={{ color: '#9a1212' }}>{data.git.error}</p>}
                <p style={{ fontSize: 12 }}>Mock values, local choices and encrypted cache are stored outside the Git workspace. Azure Key Vault support is planned, not active.</p>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
};

export default StudioPanel;
