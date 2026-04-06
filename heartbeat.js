#!/usr/bin/env node
// AIBTC Heartbeat — GitHub Actions CI
// Derives BTC key from CLIENT_MNEMONIC, signs BIP-322, POSTs to /api/heartbeat

const https = require('https');
const bip39 = require('bip39');
const { BIP32Factory } = require('bip32');
const ecc = require('tiny-secp256k1');
const bitcoin = require('bitcoinjs-lib');
const bitcoinMessage = require('bitcoinjs-message');

const BTC_ADDRESS = 'bc1q0vd9ukgcl4mkwnw2p4rvn4q3urdfyz2nukpgzt';
const DERIVATION_PATH = "m/84'/0'/0'/0/0";

function log(msg) { console.log(msg); }

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

async function signMessage(mnemonic, message) {
  const bip32 = BIP32Factory(ecc);
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const root = bip32.fromSeed(seed);
  const child = root.derivePath(DERIVATION_PATH);
  if (!child.privateKey) throw new Error('Could not derive private key');

  // BIP-322 simple signature for P2WPKH (native SegWit bc1q)
  const sig = bitcoinMessage.sign(message, child.privateKey, true, { segwitType: 'p2wpkh' });
  return sig.toString('base64');
}

async function main() {
  const timestamp = new Date().toISOString();
  log(`[${timestamp}] Heartbeat started`);

  const mnemonic = process.env.CLIENT_MNEMONIC;
  if (!mnemonic) throw new Error('CLIENT_MNEMONIC not set');

  const message = `AIBTC Check-In | ${timestamp}`;
  log(`[${timestamp}] Signing: "${message}"`);

  const signature = await signMessage(mnemonic, message);
  log(`[${timestamp}] Signature obtained`);

  const res = await httpsPost('https://aibtc.com/api/heartbeat', {
    btcAddress: BTC_ADDRESS,
    timestamp,
    signature
  });

  log(`[${timestamp}] ${res.status} ${res.body}`);
  if (res.status !== 200) {
    const body = JSON.parse(res.body);
    // 429 rate limit is not a fatal error
    if (res.status === 429) {
      log(`[${timestamp}] Rate limited — OK, next run in 15 min`);
      process.exit(0);
    }
    throw new Error(`HTTP ${res.status}: ${res.body}`);
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
