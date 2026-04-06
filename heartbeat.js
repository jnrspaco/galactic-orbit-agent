#!/usr/bin/env node
// AIBTC Heartbeat for GitHub Actions
// Uses CLIENT_MNEMONIC env var — no wallet file needed

const { spawn } = require('child_process');
const https = require('https');

const BTC_ADDRESS = 'bc1q0vd9ukgcl4mkwnw2p4rvn4q3urdfyz2nukpgzt';

function log(msg) { console.log(msg); }

class McpClient {
  constructor() {
    this.proc = null;
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.proc = spawn('node', ['./node_modules/@aibtc/mcp-server/dist/index.js'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env }
      });
      this.proc.stdout.on('data', (data) => {
        this.buffer += data.toString();
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id != null && this.pending.has(msg.id)) {
              const { resolve, reject } = this.pending.get(msg.id);
              this.pending.delete(msg.id);
              if (msg.error) reject(new Error(msg.error.message));
              else resolve(msg.result);
            }
          } catch (_) {}
        }
      });
      this.proc.stderr.on('data', () => {});
      this.proc.on('error', reject);
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this._write({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'aibtc-heartbeat-ci', version: '1.0.0' } } });
    }).then(result => {
      this._write({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return result;
    });
  }

  _write(msg) { this.proc.stdin.write(JSON.stringify(msg) + '\n'); }

  callTool(name, args = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this._write({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    });
  }

  stop() { try { this.proc && this.proc.kill(); } catch (_) {} }
}

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const timestamp = new Date().toISOString();
  log(`[${timestamp}] Heartbeat started`);

  if (!process.env.CLIENT_MNEMONIC) {
    throw new Error('CLIENT_MNEMONIC environment variable not set');
  }

  const message = `AIBTC Check-In | ${timestamp}`;
  const client = new McpClient();

  try {
    await client.start();

    // Sign message using mnemonic (no wallet_unlock needed with CLIENT_MNEMONIC)
    const signRaw = await client.callTool('btc_sign_message', { message });
    const sign = JSON.parse(signRaw.content?.[0]?.text ?? '{}');
    if (!sign.signature) throw new Error(`No signature: ${JSON.stringify(sign)}`);

    const res = await httpsPost('https://aibtc.com/api/heartbeat', {
      btcAddress: BTC_ADDRESS,
      timestamp,
      signature: sign.signature
    });

    log(`[${timestamp}] ${res.status} ${res.body}`);
    if (res.status !== 200) process.exit(1);
  } finally {
    client.stop();
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
