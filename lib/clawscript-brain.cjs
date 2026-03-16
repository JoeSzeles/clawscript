'use strict';
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const HOME = process.env.HOME || '/home/runner';
const BRAINS_DIR = path.join(HOME, '.openclaw', 'brains');
const BRAIN_SERVER_SCRIPT = path.join(__dirname, 'brain-engine-server.cjs');

try { fs.mkdirSync(BRAINS_DIR, { recursive: true }); } catch (_) {}

let activeBrainPort = 0;
let activeBrainName = 'default';
const runningProcesses = {};

function readDefaultPort() {
  if (activeBrainPort) return activeBrainPort;
  const portFiles = [
    path.join(HOME, '.openclaw', 'brain-engine-port'),
    path.join(HOME, '.openclaw', 'agent-brain-engine-port'),
  ];
  for (const pf of portFiles) {
    try {
      const p = parseInt(fs.readFileSync(pf, 'utf8').trim());
      if (p > 0) return p;
    } catch (_) {}
  }
  return 0;
}

function getPort() {
  if (activeBrainName !== 'default' && runningProcesses[activeBrainName]) {
    return runningProcesses[activeBrainName].port;
  }
  return readDefaultPort();
}

function brainFetch(endpoint, options) {
  const port = getPort();
  if (!port) return Promise.reject(new Error('No brain engine port found. Boot a brain first.'));
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port,
      path: endpoint,
      method: (options && options.method) || 'GET',
      headers: (options && options.headers) || {},
      timeout: 10000,
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (_) { resolve(data); }
      });
    });
    req.on('error', (e) => reject(new Error('Brain connection failed: ' + e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Brain request timed out')); });
    if (options && options.body) req.write(options.body);
    req.end();
  });
}

async function boot(config) {
  const body = {};
  if (config) {
    if (config.sensory) body.sensory = parseInt(config.sensory);
    if (config.inter) body.inter = parseInt(config.inter);
    if (config.motor) body.motor = parseInt(config.motor);
    if (config.preset) body.preset = config.preset;
  }
  return brainFetch('/boot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function status() {
  return brainFetch('/status');
}

async function stimulate(inputs) {
  return brainFetch('/stimulate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs }),
  });
}

async function observe() {
  return brainFetch('/observe');
}

async function feedback(type, data) {
  return brainFetch('/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, ...(data || {}) }),
  });
}

async function train(enabled, direction) {
  return brainFetch('/training', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: enabled !== false, direction: direction || null }),
  });
}

async function save() {
  return brainFetch('/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
}

async function load() {
  return brainFetch('/boot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
}

async function architecture() {
  return brainFetch('/architecture');
}

function profilePath(name) {
  return path.join(BRAINS_DIR, name + '.json');
}

function loadProfile(name) {
  try {
    return JSON.parse(fs.readFileSync(profilePath(name), 'utf8'));
  } catch (_) {
    return null;
  }
}

function saveProfile(name, config) {
  const profile = {
    name,
    sensory: config.sensory || 600,
    inter: config.inter || 3600,
    motor: config.motor || 800,
    dataDir: config.dataDir || path.join(BRAINS_DIR, name),
    createdAt: config.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(profilePath(name), JSON.stringify(profile, null, 2));
  return profile;
}

async function create(name, config) {
  if (!name || typeof name !== 'string') throw new Error('Brain name is required');
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');

  const sensory = (config && config.sensory) ? parseInt(config.sensory) : 600;
  const inter = (config && config.inter) ? parseInt(config.inter) : 3600;
  const motor = (config && config.motor) ? parseInt(config.motor) : 800;
  const dataDir = path.join(BRAINS_DIR, safeName);
  const portFilename = 'brain-port-' + safeName;

  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) {}

  const profile = saveProfile(safeName, { sensory, inter, motor, dataDir });

  if (runningProcesses[safeName]) {
    try { runningProcesses[safeName].proc.kill('SIGTERM'); } catch (_) {}
    delete runningProcesses[safeName];
  }

  return new Promise((resolve, reject) => {
    const proc = spawn('node', [BRAIN_SERVER_SCRIPT], {
      cwd: __dirname,
      env: {
        ...process.env,
        BRAIN_PORT: '0',
        BRAIN_INSTANCE_ID: safeName,
        BRAIN_DATA_DIR: dataDir,
        BRAIN_PORT_FILENAME: portFilename,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let port = 0;
    let resolved = false;

    proc.stdout.on('data', (data) => {
      const lines = data.toString().trim().split('\n');
      for (const line of lines) {
        const portMatch = line.match(/listening on 127\.0\.0\.1:(\d+)/);
        if (portMatch && !resolved) {
          port = parseInt(portMatch[1]);
          runningProcesses[safeName] = { proc, port, profile };
          resolved = true;
          resolve({ ok: true, name: safeName, port, sensory, inter, motor, dataDir, pid: proc.pid });
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.error(`[brain:${safeName}] ${msg}`);
    });

    proc.on('exit', (code) => {
      if (runningProcesses[safeName] && runningProcesses[safeName].proc === proc) {
        delete runningProcesses[safeName];
      }
      if (!resolved) {
        resolved = true;
        reject(new Error(`Brain "${safeName}" exited before starting (code=${code})`));
      }
    });

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Failed to spawn brain "${safeName}": ${err.message}`));
      }
    });

    setTimeout(() => {
      if (!resolved) {
        const portFile = path.join(HOME, '.openclaw', portFilename);
        try {
          port = parseInt(fs.readFileSync(portFile, 'utf8').trim());
          if (port > 0) {
            runningProcesses[safeName] = { proc, port, profile };
            resolved = true;
            resolve({ ok: true, name: safeName, port, sensory, inter, motor, dataDir, pid: proc.pid });
            return;
          }
        } catch (_) {}
        resolved = true;
        reject(new Error(`Brain "${safeName}" did not report its port within 15s`));
      }
    }, 15000);
  });
}

function use(name) {
  if (!name || name === 'default') {
    activeBrainName = 'default';
    activeBrainPort = 0;
    return { ok: true, active: 'default' };
  }
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (runningProcesses[safeName]) {
    activeBrainName = safeName;
    activeBrainPort = runningProcesses[safeName].port;
    return { ok: true, active: safeName, port: activeBrainPort };
  }
  const profile = loadProfile(safeName);
  if (!profile) throw new Error(`Brain "${safeName}" not found. Create it first with BRAIN_CREATE.`);
  throw new Error(`Brain "${safeName}" exists but is not running. Use BRAIN_CREATE to start it.`);
}

function list() {
  const profiles = [];
  try {
    const files = fs.readdirSync(BRAINS_DIR).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(BRAINS_DIR, f), 'utf8'));
        p.running = !!runningProcesses[p.name];
        if (p.running) p.port = runningProcesses[p.name].port;
        profiles.push(p);
      } catch (_) {}
    }
  } catch (_) {}
  return profiles;
}

function destroy(name, deleteWeights) {
  const safeName = (name || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  if (!safeName) throw new Error('Brain name is required');

  if (runningProcesses[safeName]) {
    try { runningProcesses[safeName].proc.kill('SIGTERM'); } catch (_) {}
    delete runningProcesses[safeName];
  }

  if (activeBrainName === safeName) {
    activeBrainName = 'default';
    activeBrainPort = 0;
  }

  const pFile = profilePath(safeName);
  const profile = loadProfile(safeName);
  try { fs.unlinkSync(pFile); } catch (_) {}

  if (deleteWeights && profile && profile.dataDir) {
    try { fs.rmSync(profile.dataDir, { recursive: true, force: true }); } catch (_) {}
  }

  return { ok: true, destroyed: safeName, weightsDeleted: !!deleteWeights };
}

function cleanup() {
  for (const [name, entry] of Object.entries(runningProcesses)) {
    try { entry.proc.kill('SIGTERM'); } catch (_) {}
  }
}

process.on('exit', cleanup);
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('SIGINT', () => { cleanup(); process.exit(0); });

module.exports = {
  boot,
  status,
  stimulate,
  observe,
  feedback,
  train,
  save,
  load,
  architecture,
  create,
  use,
  list,
  destroy,
  cleanup,
};
