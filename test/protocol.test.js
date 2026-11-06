'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const protocol = require('../public/protocol.js');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function receiving(overrides = {}) {
  return { status: 'receiving', bytes: 0, size: 10 * 1024 * 1024, writeError: null, ...overrides };
}

test('validateIncomingChunk accepts boundaries and rejects invalid chunks', () => {
  assert.equal(protocol.validateIncomingChunk(receiving(), 1), null);
  assert.equal(protocol.validateIncomingChunk(receiving(), 64 * 1024), null);
  assert.equal(protocol.validateIncomingChunk(receiving(), protocol.MAX_CHUNK_BYTES), null);
  assert.equal(protocol.validateIncomingChunk(receiving({ size: 64 * 1024 }), 64 * 1024), null);

  // Exactly filling the declared size is fine; one byte over is not.
  assert.equal(protocol.validateIncomingChunk(receiving({ bytes: 1000, size: 1024 }), 24), null);
  assert.equal(protocol.validateIncomingChunk(receiving({ bytes: 1000, size: 1024 }), 25), 'size-overflow');

  assert.equal(protocol.validateIncomingChunk(receiving(), 0), 'empty');
  assert.equal(protocol.validateIncomingChunk(receiving(), protocol.MAX_CHUNK_BYTES + 1), 'chunk-too-large');
  assert.equal(protocol.validateIncomingChunk(receiving(), -1), 'invalid-length');
  assert.equal(protocol.validateIncomingChunk(receiving(), 1.5), 'invalid-length');
  assert.equal(protocol.validateIncomingChunk(receiving(), Number.NaN), 'invalid-length');
  assert.equal(protocol.validateIncomingChunk(receiving({ bytes: Number.NaN }), 1), 'invalid-length');
  assert.equal(protocol.validateIncomingChunk(receiving({ size: Number.MAX_SAFE_INTEGER + 2 }), 1), 'invalid-length');
});

test('validateIncomingChunk ignores chunks outside the receiving state', () => {
  for (const status of ['incoming', 'preparing', 'processing', 'complete', 'cancelled', 'error']) {
    assert.equal(protocol.validateIncomingChunk(receiving({ status }), 10), 'ignored-status', status);
  }
  assert.equal(protocol.validateIncomingChunk(null, 10), 'ignored-status');
});

test('validateIncomingChunk reports disk write failures before further writes', () => {
  const error = new Error('disk full');
  assert.equal(protocol.validateIncomingChunk(receiving({ writeError: error }), 10), 'write-error');
});

test('zero-byte files accept no data and a zero chunk is a no-op', () => {
  assert.equal(protocol.validateFileSize(0, 1024), null);
  assert.equal(protocol.validateIncomingChunk(receiving({ size: 0 }), 0), 'empty');
  assert.equal(protocol.validateIncomingChunk(receiving({ size: 0 }), 1), 'size-overflow');
});

test('validateFileSize enforces integer, non-negative and maximum sizes', () => {
  const max = 100 * 1024 * 1024 * 1024;
  assert.equal(protocol.validateFileSize(0, max), null);
  assert.equal(protocol.validateFileSize(max, max), null);
  assert.equal(protocol.validateFileSize(max + 1, max), 'too-large');
  assert.equal(protocol.validateFileSize(-1, max), 'invalid-size');
  assert.equal(protocol.validateFileSize(1.5, max), 'invalid-size');
  assert.equal(protocol.validateFileSize(Number.NaN, max), 'invalid-size');
  assert.equal(protocol.validateFileSize('1024', max), 'invalid-size');
});

test('isSafeId only accepts the documented identifier shape', () => {
  assert.equal(protocol.isSafeId('123e4567-e89b-12d3-a456-426614174000'), true);
  assert.equal(protocol.isSafeId('abcdefgh'), true);
  assert.equal(protocol.isSafeId('a'.repeat(64)), true);
  assert.equal(protocol.isSafeId('abcdefg'), false);
  assert.equal(protocol.isSafeId('a'.repeat(65)), false);
  assert.equal(protocol.isSafeId('bad id here'), false);
  assert.equal(protocol.isSafeId('../../etc'), false);
  assert.equal(protocol.isSafeId(''), false);
  assert.equal(protocol.isSafeId(null), false);
  assert.equal(protocol.isSafeId({ id: 'abcdefgh' }), false);
});

test('sanitizeFileName strips paths, control characters and Windows reserved names', () => {
  assert.equal(protocol.sanitizeFileName('../../etc/passwd'), 'passwd');
  assert.equal(protocol.sanitizeFileName('C:\\Windows\\system32\\x.dll'), 'x.dll');
  assert.equal(protocol.sanitizeFileName('a\u0000b\u001fc.txt'), 'a_b_c.txt');
  assert.equal(protocol.sanitizeFileName('report<>:"|?*.pdf'), 'report_______.pdf');
  assert.equal(protocol.sanitizeFileName('name...  '), 'name');
  assert.equal(protocol.sanitizeFileName('CON'), '_CON');
  assert.equal(protocol.sanitizeFileName('con.txt'), '_con.txt');
  assert.equal(protocol.sanitizeFileName('..'), 'dosya');
  assert.equal(protocol.sanitizeFileName(''), 'dosya');
  assert.equal(protocol.sanitizeFileName('a'.repeat(300)).length, 180);
});

test('hasTurnServer detects TURN/TURNS across URL shapes', () => {
  assert.equal(protocol.hasTurnServer([{ urls: 'stun:stun.l.google.com:19302' }]), false);
  assert.equal(protocol.hasTurnServer([{ urls: ['stun:a', 'stun:b'] }]), false);
  assert.equal(
    protocol.hasTurnServer([
      { urls: ['stun:a'] },
      { urls: ['turn:relay.example:3478?transport=udp'], username: 'u', credential: 'c' },
    ]),
    true,
  );
  assert.equal(protocol.hasTurnServer([{ urls: 'turns:relay.example:5349?transport=tcp' }]), true);
  assert.equal(protocol.hasTurnServer([{ urls: '  TURN:relay.example:3478  ' }]), true);
  assert.equal(protocol.hasTurnServer([{ urls: null }]), false);
  assert.equal(protocol.hasTurnServer([]), false);
  assert.equal(protocol.hasTurnServer(null), false);
});

test('sanitizeMime keeps a safe type token', () => {
  assert.equal(protocol.sanitizeMime('text/plain'), 'text/plain');
  assert.equal(protocol.sanitizeMime('image/svg+xml; charset=utf-8'), 'image/svg+xmlcharsetutf-8');
  assert.equal(protocol.sanitizeMime('<script>'), 'script');
  assert.equal(protocol.sanitizeMime(''), 'application/octet-stream');
  assert.equal(protocol.sanitizeMime(null), 'application/octet-stream');
});

test('handleControlMessage handles every declared control type and nothing else', () => {
  const start = APP_JS.indexOf('function handleControlMessage(');
  assert.notEqual(start, -1, 'handleControlMessage must exist');
  const end = APP_JS.indexOf('\n  }\n', start);
  assert.notEqual(end, -1, 'handleControlMessage must end');
  const body = APP_JS.slice(start, end);
  const handled = [...body.matchAll(/case '([a-z-]+)':/g)].map((match) => match[1]).sort();

  assert.deepEqual(
    handled,
    [...protocol.CONTROL_TYPES].sort(),
    'The datachannel switch must match CONTROL_TYPES exactly (a missing case means messages are silently dropped)',
  );
});
