'use strict';
// Metadata only. No payload reads and no tracker fields are retained.
const crypto = require('crypto');
const MAX_BYTES = 16 * 1024 * 1024;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesDigest = value => crypto.createHash('sha256').update(value).digest('hex');
function fail (code) { throw new Error('CG_' + code); }
function integer (n, min = 0) { if (!Number.isSafeInteger(n) || n < min) fail('INTEGER'); return n; }
function text (b) {
  if (!Buffer.isBuffer(b) || !Buffer.from(b.toString('utf8')).equals(b)) fail('ENCODING');
  return b.toString('utf8');
}
function component (s) {
  if (typeof s !== 'string' || !s || s === '.' || s === '..' || /[/\\]/.test(s) || [...s].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) fail('PATH');
  return s;
}
function absolute (s) {
  if (typeof s !== 'string' || !s.startsWith('/') || s === '/' || s.endsWith('/')) fail('PATH');
  s.slice(1).split('/').forEach(component); return s;
}
function within (file, root) { return file === root || file.startsWith(root + '/'); }
function hash (s) { if (typeof s !== 'string' || !/^[a-f0-9]{40}$/.test(s)) fail('HASH'); return s; }
function key (s) { if (typeof s !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(s)) fail('CLIENT'); return s; }

function decode (data) {
  if (!Buffer.isBuffer(data) || !data.length || data.length > MAX_BYTES) fail('METADATA_SIZE');
  let pos = 0; let nodes = 0; let rawInfo;
  function read (depth = 0) {
    if (++nodes > 300000 || depth > 64 || pos >= data.length) fail('BENCODE_BOUND');
    const token = data[pos++];
    if (token === 105) {
      const end = data.indexOf(101, pos); const value = data.slice(pos, end).toString('ascii');
      if (end < 0 || !/^(0|-?[1-9][0-9]{0,15})$/.test(value)) fail('BENCODE_INTEGER');
      pos = end + 1; const n = Number(value); if (!Number.isSafeInteger(n)) fail('BENCODE_INTEGER'); return n;
    }
    if (token === 108 || token === 100) {
      const result = token === 108 ? [] : Object.create(null);
      while (pos < data.length && data[pos] !== 101) {
        if (token === 108) { result.push(read(depth + 1)); continue; }
        const name = text(read(depth + 1));
        if (Object.prototype.hasOwnProperty.call(result, name)) fail('BENCODE_DUPLICATE');
        const start = pos; result[name] = read(depth + 1);
        if (depth === 0 && name === 'info') rawInfo = data.slice(start, pos);
      }
      if (pos >= data.length) fail('BENCODE_CONTAINER'); pos++; return result;
    }
    pos--;
    const colon = data.indexOf(58, pos);
    if (colon < 0 || colon - pos > 9) fail('BENCODE_STRING');
    const value = data.slice(pos, colon).toString('ascii');
    if (!/^(0|[1-9][0-9]*)$/.test(value)) fail('BENCODE_STRING');
    const length = Number(value); pos = colon + 1;
    if (pos + length > data.length) fail('BENCODE_STRING');
    const result = data.slice(pos, pos + length); pos += length; return result;
  }
  const meta = read();
  if (pos !== data.length || !rawInfo || !meta.info || Array.isArray(meta.info) || Buffer.isBuffer(meta.info)) fail('METADATA_INFO');
  return { meta, info: meta.info, rawInfo };
}

function metadata (data) {
  const { meta, info, rawInfo } = decode(data);
  if ('meta version' in info || 'file tree' in info || 'symlink path' in info || 'attr' in info) fail('UNSUPPORTED_FORMAT');
  if (meta.encoding && text(meta.encoding).toUpperCase() !== 'UTF-8') fail('ENCODING');
  const name = component(text(info.name));
  if (info['name.utf-8'] && text(info['name.utf-8']) !== name) fail('ENCODING');
  const files = [];
  if ('files' in info) {
    if (!Array.isArray(info.files) || !info.files.length || info.files.length > 20000 || 'length' in info) fail('FILES');
    for (const f of info.files) {
      if (!f || !Array.isArray(f.path) || !f.path.length || 'attr' in f || 'symlink path' in f) fail('UNSUPPORTED_FORMAT');
      const parts = f.path.map(x => component(text(x)));
      if (f['path.utf-8'] && JSON.stringify(f['path.utf-8'].map(text)) !== JSON.stringify(parts)) fail('ENCODING');
      files.push([name + '/' + parts.join('/'), integer(f.length)]);
    }
  } else files.push([name, integer(info.length, 1)]);
  if (new Set(files.map(f => f[0])).size !== files.length) fail('DUPLICATE_FILE');
  const size = integer(files.reduce((n, f) => n + f[1], 0), 1);
  const pieceLength = integer(info['piece length'], 1); const pieces = info.pieces;
  if (pieceLength > 67108864 || !Buffer.isBuffer(pieces) || pieces.length !== Math.ceil(size / pieceLength) * 20) fail('PIECES');
  return {
    hash: crypto.createHash('sha1').update(rawInfo).digest('hex'),
    files,
    size,
    contentId: digest(['v1', pieceLength, bytesDigest(pieces), files])
  };
}

function binding (row, clientId) {
  return {
    clientId: key(clientId),
    hash: hash(row.hash),
    addedOn: integer(row.added_on, 1),
    savePath: absolute(row.save_path),
    contentPath: absolute(row.content_path),
    size: integer(row.total_size, 1)
  };
}
function manifest (row, files) {
  const save = absolute(row.save_path); const content = absolute(row.content_path);
  if (!Array.isArray(files) || !files.length || files.length > 20000) fail('FILES');
  const ordered = [...files].sort((a, b) => a.index - b.index).map((f, i) => {
    if (f.index !== i || typeof f.name !== 'string' || f.name.startsWith('/')) fail('MANIFEST');
    f.name.split('/').forEach(component);
    const full = save + '/' + f.name;
    if (!within(full, content)) fail('OUTSIDE_CONTENT');
    return [f.name, integer(f.size)];
  });
  if (new Set(ordered.map(f => f[0])).size !== ordered.length) fail('DUPLICATE_FILE');
  return { ordered, physical: ordered.map(([name, size]) => [save + '/' + name, size]), digest: digest(ordered) };
}
function identity (data, row, files, clientId) {
  const m = metadata(data); const b = binding(row, clientId); const f = manifest(row, files);
  if (m.hash !== b.hash || m.size !== b.size || digest(m.files) !== f.digest) fail('IDENTITY_MISMATCH');
  if (files.some(f => !(f.priority > 0))) fail('SELECTIVE_DOWNLOAD');
  return { schema: 1, kind: 'v1-exact', binding: b, manifestDigest: f.digest, contentId: m.contentId };
}
function current (proof, row, files, clientId) {
  try {
    if (['moving', 'missingFiles', 'error', 'checkingUP', 'checkingDL', 'checkingResumeData'].includes(row.state)) return false;
    return proof.schema === 1 && proof.kind === 'v1-exact' && /^[a-f0-9]{64}$/.test(proof.contentId) &&
      digest(proof.binding) === digest(binding(row, clientId)) && proof.manifestDigest === manifest(row, files).digest &&
      files.every(f => f.priority > 0);
  } catch (_) { return false; }
}

module.exports = { MAX_BYTES, digest, bytesDigest, absolute, within, hash, key, metadata, binding, manifest, identity, current };
