#!/usr/bin/env node
// AIBTC News Signal — GitHub Actions CI
// Imports wallet from CLIENT_MNEMONIC, searches arxiv, files signal on "security" beat

const { spawn } = require('child_process');
const path = require('path');

const BEAT_SLUG = 'security';
const CI_WALLET_PASS = 'ci-news-agent-temp';
const MCP_SERVER = path.join(__dirname, 'node_modules/@aibtc/mcp-server/dist/index.js');

function log(msg) { console.log(msg); }

function safeJson(text) {
  try { return JSON.parse(text); } catch (_) { return {}; }
}

class McpClient {
  constructor() {
    this.proc = null;
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.proc = spawn('node', [MCP_SERVER], {
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
      this.proc.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) process.stderr.write('[MCP] ' + s + '\n'); });
      this.proc.on('error', reject);
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this._write({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'aibtc-news-ci', version: '1.0.0' } } });
    }).then(r => { this._write({ jsonrpc: '2.0', method: 'notifications/initialized' }); return r; });
  }

  _write(msg) { this.proc.stdin.write(JSON.stringify(msg) + '\n'); }

  callTool(name, args = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP tool "${name}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject:  (e) => { clearTimeout(timer); reject(e); }
      });
      this._write({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    });
  }

  stop() { try { this.proc && this.proc.kill(); } catch (_) {} }
}

function pickBestPaper(papers, alreadyFiled) {
  const keywords = ['bitcoin', 'crypto', 'agent', 'security', 'blockchain', 'wallet', 'llm', 'autonomous', 'attack', 'vulnerability'];
  return papers
    .filter(p => !alreadyFiled.includes(p.id))
    .map(p => {
      const text = (p.title + ' ' + p.abstract + ' ' + (p.tags || []).join(' ')).toLowerCase();
      const bonus = keywords.filter(k => text.includes(k)).length;
      return { ...p, relevance: (p.score || 0) + bonus * 3 };
    })
    .sort((a, b) => b.relevance - a.relevance)[0] || null;
}

function buildHeadline(paper) {
  const t = paper.title.replace(/\s+/g, ' ').trim();
  return t.length <= 120 ? t : t.slice(0, 117) + '...';
}

function buildBody(paper) {
  const abstract = paper.abstract.replace(/\s+/g, ' ').trim();
  const sentences = abstract.match(/[^.!?]+[.!?]+/g) || [abstract];
  let body = sentences.slice(0, 3).join(' ').trim();
  if (body.length > 950) body = body.slice(0, 947) + '...';
  return body;
}

function sanitizeTags(raw) {
  return [...new Set(
    raw.map(t => t.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''))
       .filter(t => t.length >= 2 && t.length <= 30)
  )].slice(0, 10);
}

// Track filed paper IDs via env var (set by workflow between steps if needed)
// In CI, each run is fresh so we just guard against same-run duplicates
const FILED_IDS = (process.env.FILED_IDS || '').split(',').filter(Boolean);

async function main() {
  const timestamp = new Date().toISOString();
  log(`[${timestamp}] news-signal.js started`);

  const mnemonic = process.env.CLIENT_MNEMONIC;
  if (!mnemonic) throw new Error('CLIENT_MNEMONIC not set');

  const client = new McpClient();
  try {
    await client.start();
    log(`[${timestamp}] MCP server started`);

    // Import wallet from mnemonic (CI runner is ephemeral — fresh each run)
    const importRaw = await client.callTool('wallet_import', {
      name: 'ci-agent',
      mnemonic,
      password: CI_WALLET_PASS
    });
    const importResult = safeJson(importRaw.content?.[0]?.text ?? '{}');
    log(`[${timestamp}] Wallet import: ${importResult.success ? 'OK' : (importRaw.content?.[0]?.text || 'unknown')}`);

    // Unlock wallet
    const unlockRaw = await client.callTool('wallet_unlock', { password: CI_WALLET_PASS });
    const unlock = safeJson(unlockRaw.content?.[0]?.text ?? '{}');
    if (!unlock.success) throw new Error(`Wallet unlock failed: ${unlockRaw.content?.[0]?.text}`);
    log(`[${timestamp}] Wallet unlocked: ${unlock['Bitcoin (L1)']?.['Native SegWit'] || 'OK'}`);

    // Search arxiv
    const searchRaw = await client.callTool('arxiv_search', {
      query: 'AI agent security Bitcoin cryptocurrency vulnerability 2026'
    });
    const search = safeJson(searchRaw.content?.[0]?.text ?? '{}');
    const papers = search.top_papers || [];
    log(`[${timestamp}] arxiv: ${papers.length} papers found`);

    if (!papers.length) {
      log(`[${timestamp}] No papers found — skipping`);
      return;
    }

    const paper = pickBestPaper(papers, FILED_IDS);
    if (!paper) {
      log(`[${timestamp}] All top papers already filed this session — skipping`);
      return;
    }
    log(`[${timestamp}] Selected: ${paper.title}`);

    const headline = buildHeadline(paper);
    const body = buildBody(paper);
    const tags = sanitizeTags(['security', 'agent', 'bitcoin', ...(paper.tags || [])]);

    // File signal
    const signalRaw = await client.callTool('news_file_signal', {
      beat_slug: BEAT_SLUG,
      headline,
      body,
      sources: [{ url: paper.abs_url, title: paper.title }],
      tags,
      disclosure: 'claude-sonnet-4-6, aibtc MCP tools, arxiv_search'
    });
    const signalText = signalRaw.content?.[0]?.text ?? '{}';
    const signal = safeJson(signalText);

    if (signalText.startsWith('Error:')) throw new Error(signalText);

    if (signal.success) {
      log(`[${timestamp}] Signal filed: ${signal.signal?.id}`);
      log(`[${timestamp}] Headline: ${headline}`);
      log(`[${timestamp}] Source: ${paper.abs_url}`);
      log(`[${timestamp}] Status: submitted`);
    } else {
      // 429 cooldown is not fatal
      const err = safeJson(signalText);
      if (err.error && err.error.includes('Cooldown')) {
        log(`[${timestamp}] Cooldown active — ${err.error}`);
      } else {
        throw new Error(`Failed to file signal: ${signalText}`);
      }
    }
  } finally {
    client.stop();
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
