const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('dev launcher starts Electron after split, colorized Rsbuild output', () => {
  const children = [];
  const spawn = (command, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    children.push({ command, options, child });
    return child;
  };
  const processMock = {
    env: { ELECTRON_RUN_AS_NODE: '1' },
    stdout: { write() {} },
    stderr: { write() {} },
    on() {}
  };

  const scriptPath = path.join(__dirname, '../../scripts/dev.js');
  vm.runInNewContext(fs.readFileSync(scriptPath, 'utf8'), {
    __dirname: path.dirname(scriptPath),
    console: { log() {} },
    process: processMock,
    require: (name) => name === 'child_process' ? { spawn } : require(name)
  });

  assert.equal(children.length, 1);
  children[0].child.stdout.emit('data', Buffer.from('\x1b[32m➜  Local:    \x1b[36mhttp://local'));
  children[0].child.stdout.emit('data', Buffer.from('host:3001/\x1b[0m\n'));

  assert.equal(children.length, 2);
  assert.equal(children[1].command, 'npm run dev');
  assert.equal(children[1].options.env.BRUNO_DEV_PORT, '3001');
  assert.equal(children[1].options.env.ELECTRON_RUN_AS_NODE, undefined);
});
