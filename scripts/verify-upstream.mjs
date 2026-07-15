#!/usr/bin/env node
/**
 * verify-upstream.mjs
 *
 * Confirms that the immutable vendor snapshot under `vendor/pi-emote-original/`
 * has not been edited. Run with --record once after cloning the pinned upstream
 * commit to regenerate vendor/pi-emote-original.sha256.
 *
 * Without --record, verifies the on-disk snapshot against the committed
 * SHA-256 record.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = join(__filename, '..', '..');
const VENDOR = join(ROOT, 'vendor', 'pi-emote-original');
const RECORD_PATH = join(ROOT, 'vendor', 'pi-emote-original.sha256');

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '.git') continue;
      walk(p, base, out);
    } else {
      out.push(relative(base, p).split(sep).join('/'));
    }
  }
  return out;
}

function buildRecord() {
  const files = walk(VENDOR);
  const lines = [];
  for (const f of files.sort()) {
    const data = readFileSync(join(VENDOR, f));
    lines.push(`${sha256(data)}  ${f}`);
  }
  return lines.join('\n') + '\n';
}

function verify() {
  if (!existsSync(RECORD_PATH)) {
    console.error(`Missing ${RECORD_PATH}; run with --record first.`);
    process.exit(1);
  }
  const expected = new Map();
  for (const line of readFileSync(RECORD_PATH, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [hash, file] = trimmed.split(/\s+/, 2);
    expected.set(file, hash);
  }
  const actual = new Map();
  for (const f of walk(VENDOR)) {
    const data = readFileSync(join(VENDOR, f));
    actual.set(f, sha256(data));
  }
  let mismatches = 0;
  for (const [f, h] of expected) {
    if (actual.get(f) !== h) {
      console.error(`MISMATCH: ${f}`);
      console.error(`  expected: ${h}`);
      console.error(`  actual:   ${actual.get(f)}`);
      mismatches++;
    }
  }
  for (const f of actual.keys()) {
    if (!expected.has(f)) {
      console.error(`UNEXPECTED: ${f}`);
      mismatches++;
    }
  }
  if (mismatches > 0) {
    console.error(`verify-upstream: ${mismatches} mismatch(es).`);
    process.exit(1);
  }
  console.log(`verify-upstream: ${expected.size} files verified.`);
}

const mode = process.argv[2];
if (mode === '--record') {
  const record = buildRecord();
  writeFileSync(RECORD_PATH, record, 'utf8');
  console.log(`Recorded ${record.split('\n').length - 1} hashes to ${RECORD_PATH}`);
} else {
  verify();
}
