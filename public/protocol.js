'use strict';

/**
 * NEON DROP — pure client-protocol helpers.
 *
 * This file is loaded in the browser as a global (`window.NeonProtocol`) and is
 * also required directly by `test/protocol.test.js`, so the validation rules
 * that guard incoming chunks, file metadata, identifiers and file names can be
 * unit tested without a DOM.
 */

(function attachProtocol(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.NeonProtocol = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createProtocol() {
  const MAX_CHUNK_BYTES = 256 * 1024;
  const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

  const CONTROL_TYPES = [
    'hello',
    'text',
    'file-start',
    'file-accept',
    'file-reject',
    'file-end',
    'file-complete',
    'file-error',
    'file-cancel',
  ];

  function isSafeId(value) {
    return typeof value === 'string' && ID_PATTERN.test(value);
  }

  /** True when at least one ICE server URL uses the TURN/TURNS scheme. */
  function hasTurnServer(iceServers) {
    if (!Array.isArray(iceServers)) return false;
    return iceServers.some((server) => {
      const urls = server && server.urls;
      const list = Array.isArray(urls) ? urls : [urls];
      return list.some((url) => typeof url === 'string' && /^turns?:/i.test(url.trim()));
    });
  }

  /**
   * Decide what to do with an incoming binary chunk.
   * @returns {null | 'ignored-status' | 'invalid-length' | 'empty' |
   *           'chunk-too-large' | 'write-error' | 'size-overflow'}
   */
  function validateIncomingChunk(transfer, byteLength) {
    if (!transfer || transfer.status !== 'receiving') return 'ignored-status';
    if (!Number.isInteger(byteLength) || byteLength < 0) return 'invalid-length';
    if (byteLength === 0) return 'empty';
    if (byteLength > MAX_CHUNK_BYTES) return 'chunk-too-large';
    if (transfer.writeError) return 'write-error';
    if (!Number.isSafeInteger(transfer.bytes) || !Number.isSafeInteger(transfer.size)) return 'invalid-length';
    if (transfer.bytes + byteLength > transfer.size) return 'size-overflow';
    return null;
  }

  /** @returns {null | 'invalid-size' | 'too-large'} */
  function validateFileSize(size, maxBytes) {
    if (!Number.isSafeInteger(size) || size < 0) return 'invalid-size';
    if (size > maxBytes) return 'too-large';
    return null;
  }

  function sanitizeFileName(value) {
    let name = String(value || '')
      .split(/[\\/]/)
      .pop()
      .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
      .replace(/[. ]+$/g, '')
      .trim();

    if (!name || name === '.' || name === '..') name = 'dosya';
    const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
    if (reserved.test(name)) name = `_${name}`;
    return name.slice(0, 180);
  }

  function sanitizeMime(value) {
    if (typeof value !== 'string' || !value) return 'application/octet-stream';
    return value.replace(/[^\w.+\/-]/g, '').slice(0, 120) || 'application/octet-stream';
  }

  return {
    MAX_CHUNK_BYTES,
    CONTROL_TYPES,
    isSafeId,
    hasTurnServer,
    validateIncomingChunk,
    validateFileSize,
    sanitizeFileName,
    sanitizeMime,
  };
});
