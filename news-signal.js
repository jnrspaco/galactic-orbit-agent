#!/usr/bin/env node
// AIBTC News Signal — GitHub Actions CI
// No MCP dependency. Searches arxiv directly, signs with BIP-137, POSTs to aibtc.news API.

'use strict';
const bip39            = require('bip39');
const { BIP32Factory } = require('bip32');
const ecc              = require('tiny-secp256k1');
const bitcoinMessage   = require('bitcoinjs-message');
const https            = require('https');
const http             = require('http');

const BTC_ADDRESS = 'bc1q0vd9ukgcl4mkwnw2p4rvn4q3urdfyz2nukpgzt';
const DERIVATION  = "m/84'/0'/0'/0/0";
const BEAT_SLUG   = 'agent-economy';
const NEWS_API    = 'https://aibtc.news';
const ARXIV_API   = 'https://export.arxiv.org/api/query';
const KEYWORDS    = ['bitcoin','crypto','agent','security','blockchain','wallet','llm','autonomous','attack','vulnerability','mcp','exploit'];

function log(msg) { console.log(msg); }

async function deriveKey(mnemonic) {
  const bip32 = BIP32Factory(ecc);
  const seed  = await bip39.mnemonicToSeed(mnemonic);
  const child = bip32.fromSeed(seed).derivePath(DERIVATION);
  if (!child.privateKey) throw new Error('Cannot derive private key');
  return child.privateKey;
}

function buildAuthHeaders(method, apiPath, privateKey) {
  const timestamp = Math.floor(Date.now() / 1000);
  const message   = `${method} ${apiPath}:${timestamp}`;
  const sig       = bitcoinMessage.sign(message, privateKey, true, { segwitType: 'p2wpkh' });
  return {
    'X-BTC-Address':   BTC_ADDRESS,
    'X-BTC-Signature': sig.toString('base64'),
    'X-BTC-Timestamp': String(timestamp),
    'Content-Type':    'application/json',
    'User-Agent':      'galactic-orbit-agent/1.0',
  };
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'galactic-orbit-agent/1.0' } }, res => {
      let raw = ''; res.on('data', c => raw += c); res.on('end', () => resolve(raw));
    }).on('error', reject);
  });
}

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
    req.on('error', reject); req.write(data); req.end();
  });
}

function parseAtomPapers(xml) {
  const papers = [];
  const entries = xml.match(/<entry>([\s\S]*?)<\/entry>/g) || [];
  for (const entry of entries) {
    const get  = tag => { const m = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)); return m ? m[1].replace(/<[^>]+>/g,'').trim() : ''; };
    const idUrl = get('id');
    const arxivId = idUrl.split('/abs/').pop().replace(/v\d+$/, '');
    papers.push({
      id:        arxivId,
      title:     get('title').replace(/\n/g, ' '),
      abstract:  get('summary').replace(/\n/g, ' '),
      published: get('published'),
      abs_url:   `https://arxiv.org/abs/${arxivId}`,
    });
  }
  return papers;
}

async function searchArxiv(query) {
  const params = new URLSearchParams({ search_query: `all:${query}`, start: '0', max_results: '30', sortBy: 'submittedDate', sortOrder: 'descending' });
  const xml = await httpGet(`${ARXIV_API}?${params}`);
  return parseAtomPapers(xml);
}

const FILED_IDS = (process.env.FILED_IDS || '').split(',').filter(Boolean);

function pickBestPaper(papers) {
  return papers
    .filter(p => p.id && !FILED_IDS.includes(p.id) && p.title && p.abstract)
    .map(p => ({ ...p, rel: KEYWORDS.filter(k => (p.title+' '+p.abstract).toLowerCase().includes(k)).length }))
    .filter(p => p.rel > 0)
    .sort((a, b) => b.rel - a.rel)[0] || null;
}

function buildHeadline(p) { const t = p.title.replace(/\s+/g,' ').trim(); return t.length<=120 ? t : t.slice(0,117)+'...'; }

function buildBody(p) {
  const s = p.abstract.replace(/\s+/g,' ').trim().match(/[^.!?]+[.!?]+/g) || [p.abstract];
  const b = s.slice(0,3).join(' ').trim();
  return b.length>950 ? b.slice(0,947)+'...' : b;
}

function sanitizeTags(raw) {
  return [...new Set(raw.map(t=>t.toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'')).filter(t=>t.length>=2&&t.length<=30))].slice(0,10);
}

async function main() {
  const ts = new Date().toISOString();
  log(`[${ts}] news-signal started`);

  const mnemonic = process.env.CLIENT_MNEMONIC;
  if (!mnemonic) throw new Error('CLIENT_MNEMONIC not set');

  const privateKey = await deriveKey(mnemonic);
  log(`[${ts}] Keys derived`);

  const papers = await searchArxiv('AI agent security Bitcoin cryptocurrency vulnerability attack');
  log(`[${ts}] arxiv: ${papers.length} papers`);

  if (!papers.length) { log(`[${ts}] No papers — skipping`); return; }

  const paper = pickBestPaper(papers);
  if (!paper) { log(`[${ts}] No relevant papers — skipping`); return; }
  log(`[${ts}] Selected (rel=${paper.rel}): ${paper.title}`);
  log(`[${ts}] Source: ${paper.abs_url}`);

  const apiPath = '/api/signals';
  const payload = {
    beat_slug:   BEAT_SLUG,
    btc_address: BTC_ADDRESS,
    headline:    buildHeadline(paper),
    body:        buildBody(paper),
    sources:     [{ url: paper.abs_url, title: paper.title }],
    tags:        sanitizeTags(['agent','bitcoin','llm','autonomous','economy','payments']),
    disclosure:  'claude-sonnet-4-6, arxiv-direct, direct-api',
  };

  const headers = buildAuthHeaders('POST', apiPath, privateKey);
  log(`[${ts}] POSTing signal...`);

  const res = await httpsPost(`${NEWS_API}${apiPath}`, headers, payload);
  log(`[${ts}] HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);

  if (res.status === 429) {
    log(`[${ts}] Cooldown ${res.body?.cooldown?.waitMinutes ?? '?'} min — exiting OK`);
    return;
  }
  if (res.status === 201 || res.status === 200) {
    log(`[${ts}] Filed: ${res.body?.signal?.id || 'unknown'} — "${payload.headline}"`);
  } else {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
