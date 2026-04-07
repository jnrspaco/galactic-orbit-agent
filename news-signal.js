#!/usr/bin/env node
// AIBTC News Signal — GitHub Actions CI
// Signs requests natively (no MCP timeout risk), POSTs directly to aibtc.news API.
// Uses MCP only for arxiv_search (fast, no auth, no timeout issues).

'use strict';
const bip39           = require('bip39');
const { BIP32Factory } = require('bip32');
const ecc             = require('tiny-secp256k1');
const btcSigner       = require('@scure/btc-signer');
const { hashSha256Sync } = require('@stacks/encryption');
const { concatBytes }    = require('@stacks/common');
const bitcoinMessage  = require('bitcoinjs-message');
const { spawn }   = require('child_process');
const https       = require('https');
const path        = require('path');

const BTC_ADDRESS = 'bc1q0vd9ukgcl4mkwnw2p4rvn4q3urdfyz2nukpgzt';
const DERIVATION  = "m/84'/0'/0'/0/0";
const BEAT_SLUG   = 'security';
const NEWS_API    = 'https://aibtc.news';
const MCP_SERVER  = path.join(__dirname, 'node_modules/@aibtc/mcp-server/dist/index.js');

function log(msg) { console.log(msg); }

// ---------------------------------------------------------------------------
// BIP-322 signing — matches aibtc.news spec: sign "METHOD /path:unix_timestamp"
// ---------------------------------------------------------------------------
function doubleSha256(data) {
  return hashSha256Sync(hashSha256Sync(data));
}

function bip322TaggedHash(message) {
  const tagBytes = new TextEncoder().encode('BIP0322-signed-message');
  const tagHash  = hashSha256Sync(tagBytes);
  const msgBytes = new TextEncoder().encode(message);
  return hashSha256Sync(concatBytes(tagHash, tagHash, msgBytes));
}

function encodeWitness(items) {
  const parts = [];
  const pushCompact = n => {
    if (n < 0xfd) parts.push(new Uint8Array([n]));
    else { const b = new Uint8Array(3); b[0]=0xfd; new DataView(b.buffer).setUint16(1,n,true); parts.push(b); }
  };
  pushCompact(items.length);
  for (const item of items) { pushCompact(item.length); parts.push(item); }
  const out = new Uint8Array(parts.reduce((s,p)=>s+p.length,0));
  let off = 0; for (const p of parts) { out.set(p,off); off+=p.length; }
  return out;
}

function bip322Sign(message, privateKey, scriptPubKey) {
  const { RawTx, Transaction } = btcSigner;
  const msgHash   = bip322TaggedHash(message);
  const scriptSig = concatBytes(new Uint8Array([0x00, 0x20]), msgHash);
  const rawTx = RawTx.encode({
    version: 0,
    inputs:  [{ txid: new Uint8Array(32), index: 0xffffffff, finalScriptSig: scriptSig, sequence: 0 }],
    outputs: [{ amount: 0n, script: scriptPubKey }],
    lockTime: 0,
  });
  const toSpendTxId = doubleSha256(rawTx).reverse();

  const tx = new Transaction({ allowUnknownOutputs: true });
  tx.addInput({ txid: toSpendTxId, index: 0, sequence: 0, witnessUtxo: { script: scriptPubKey, amount: 0n } });
  tx.addOutput({ script: new Uint8Array([0x6a]), amount: 0n });
  tx.signIdx(privateKey, 0);
  tx.finalize();

  const witness = tx.getInput(0).finalScriptWitness;
  return Buffer.from(encodeWitness(witness)).toString('base64');
}

async function deriveKeys(mnemonic) {
  const bip32 = BIP32Factory(ecc);
  const seed  = await bip39.mnemonicToSeed(mnemonic);
  const child = bip32.fromSeed(seed).derivePath(DERIVATION);
  if (!child.privateKey) throw new Error('Cannot derive private key');
  const pubKey     = new Uint8Array(child.publicKey);
  const privKey    = new Uint8Array(child.privateKey);
  const { script } = btcSigner.p2wpkh(pubKey, btcSigner.NETWORK);
  return { privateKey: privKey, rawPrivateKey: child.privateKey, scriptPubKey: script };
}

// BIP-137 / bitcoinjs-message signing (segwit p2wpkh)
function bip137Sign(message, rawPrivateKey) {
  return bitcoinMessage.sign(message, rawPrivateKey, true, { segwitType: 'p2wpkh' }).toString('base64');
}

function buildAuthHeaders(method, apiPath, rawPrivateKey) {
  const timestamp = Math.floor(Date.now() / 1000);
  const message   = `${method} ${apiPath}:${timestamp}`;
  const signature = bip137Sign(message, rawPrivateKey);
  return {
    'X-BTC-Address':   BTC_ADDRESS,
    'X-BTC-Signature': signature,
    'X-BTC-Timestamp': String(timestamp),
    'Content-Type':    'application/json',
    'User-Agent':      'galactic-orbit-agent/1.0',
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data   = JSON.stringify(body);
    const req    = https.request({
      hostname: parsed.hostname, path: parsed.pathname,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); } catch (_) { resolve({ status: res.statusCode, body: raw }); } });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

// ---------------------------------------------------------------------------
// arxiv via MCP (read-only, fast — only this uses MCP)
// ---------------------------------------------------------------------------
class McpClient {
  constructor() { this.proc=null; this.buffer=''; this.pending=new Map(); this.nextId=1; }

  start() {
    return new Promise((resolve, reject) => {
      this.proc = spawn('node', [MCP_SERVER], { stdio:['pipe','pipe','pipe'], env:{...process.env} });
      this.proc.stdout.on('data', d => {
        this.buffer += d.toString();
        const lines = this.buffer.split('\n'); this.buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try { const m=JSON.parse(line); if (m.id!=null&&this.pending.has(m.id)) { const {resolve,reject}=this.pending.get(m.id); this.pending.delete(m.id); m.error?reject(new Error(m.error.message)):resolve(m.result); } } catch(_){}
        }
      });
      this.proc.stderr.on('data', d => { const s=d.toString().trim(); if(s) process.stderr.write('[MCP] '+s+'\n'); });
      this.proc.on('error', reject);
      const id=this.nextId++;
      this.pending.set(id,{resolve,reject});
      this._write({jsonrpc:'2.0',id,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'aibtc-news-ci',version:'1.0'}}});
    }).then(r=>{this._write({jsonrpc:'2.0',method:'notifications/initialized'});return r;});
  }

  _write(m) { this.proc.stdin.write(JSON.stringify(m)+'\n'); }

  callTool(name, args={}, ms=20000) {
    return new Promise((resolve,reject)=>{
      const id=this.nextId++;
      const t=setTimeout(()=>{this.pending.delete(id);reject(new Error(`MCP "${name}" timed out`));},ms);
      this.pending.set(id,{resolve:v=>{clearTimeout(t);resolve(v);},reject:e=>{clearTimeout(t);reject(e);}});
      this._write({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}});
    });
  }

  stop() { try{this.proc?.kill();}catch(_){} }
}

// ---------------------------------------------------------------------------
// Paper selection
// ---------------------------------------------------------------------------
const KEYWORDS = ['bitcoin','crypto','agent','security','blockchain','wallet','llm','autonomous','attack','vulnerability','mcp'];
const FILED_IDS = (process.env.FILED_IDS||'').split(',').filter(Boolean);

function pickBestPaper(papers) {
  return papers
    .filter(p => !FILED_IDS.includes(p.id))
    .map(p => ({ ...p, relevance: (p.score||0) + KEYWORDS.filter(k=>(p.title+' '+p.abstract+' '+(p.tags||[]).join(' ')).toLowerCase().includes(k)).length*3 }))
    .sort((a,b)=>b.relevance-a.relevance)[0] || null;
}

function buildHeadline(p) { const t=p.title.replace(/\s+/g,' ').trim(); return t.length<=120?t:t.slice(0,117)+'...'; }

function buildBody(p) {
  const s=p.abstract.replace(/\s+/g,' ').trim().match(/[^.!?]+[.!?]+/g)||[p.abstract];
  const b=s.slice(0,3).join(' ').trim();
  return b.length>950?b.slice(0,947)+'...':b;
}

function sanitizeTags(raw) {
  return [...new Set(raw.map(t=>t.toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'')).filter(t=>t.length>=2&&t.length<=30))].slice(0,10);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const ts = new Date().toISOString();
  log(`[${ts}] news-signal started`);

  const mnemonic = process.env.CLIENT_MNEMONIC;
  if (!mnemonic) throw new Error('CLIENT_MNEMONIC not set');

  const { rawPrivateKey } = await deriveKeys(mnemonic);
  log(`[${ts}] Keys derived`);

  // arxiv search via MCP
  const mcp = new McpClient();
  let papers = [];
  try {
    await mcp.start();
    const raw    = await mcp.callTool('arxiv_search', { query: 'AI agent security Bitcoin cryptocurrency vulnerability 2026' });
    papers = JSON.parse(raw.content?.[0]?.text ?? '{}').top_papers || [];
    log(`[${ts}] arxiv: ${papers.length} papers`);
  } finally {
    mcp.stop();
  }

  if (!papers.length) { log(`[${ts}] No papers — skipping`); return; }

  const paper = pickBestPaper(papers);
  if (!paper) { log(`[${ts}] All top papers already filed — skipping`); return; }
  log(`[${ts}] Selected: ${paper.title}`);
  log(`[${ts}] Source: ${paper.abs_url}`);

  const apiPath = '/api/signals';
  const payload = {
    beat_slug:   BEAT_SLUG,
    btc_address: BTC_ADDRESS,
    headline:    buildHeadline(paper),
    body:        buildBody(paper),
    sources:     [{ url: paper.abs_url, title: paper.title }],
    tags:        sanitizeTags(['security','agent','bitcoin',...(paper.tags||[])]),
    disclosure:  'claude-sonnet-4-6, arxiv_search, direct-api',
  };

  const headers = buildAuthHeaders('POST', apiPath, rawPrivateKey);
  log(`[${ts}] POSTing to ${NEWS_API}${apiPath}`);

  const res = await httpsPost(`${NEWS_API}${apiPath}`, headers, payload);
  log(`[${ts}] HTTP ${res.status}: ${JSON.stringify(res.body).slice(0,200)}`);

  if (res.status === 429) {
    log(`[${ts}] Cooldown ${res.body?.cooldown?.waitMinutes ?? '?'} min — exiting OK`);
    return;
  }
  if (res.status === 201 || res.status === 200) {
    const id = res.body?.signal?.id || res.body?.id || 'unknown';
    log(`[${ts}] Filed signal: ${id} — "${payload.headline}"`);
  } else {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
