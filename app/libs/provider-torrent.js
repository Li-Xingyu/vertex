'use strict';
const { fail } = require('./provider-schema');

// Hash the original info byte range, never a decoded/re-encoded dictionary.
// A bounded scanner also rejects duplicate dictionary keys and trailing data.
function infoSlice (body) {
  if (!Buffer.isBuffer(body) || body.length > 16 * 1024 ** 2 || body[0] !== 100) fail('PROVIDER_TORRENT_INVALID');
  let at = 0; let nodes = 0; let info = null;
  const bad = () => fail('PROVIDER_TORRENT_INVALID');
  function string () {
    const colon = body.indexOf(58, at);
    if (colon < 0 || colon - at > 10) bad();
    const text = body.toString('ascii', at, colon);
    if (!/^(?:0|[1-9]\d*)$/.test(text)) bad();
    const length = Number(text); const start = colon + 1;
    if (!Number.isSafeInteger(length) || start + length > body.length) bad();
    at = start + length; return body.subarray(start, at);
  }
  function walk (depth) {
    if (depth > 128 || ++nodes > 1000000 || at >= body.length) bad();
    const kind = body[at];
    if (kind === 100) {
      at++; const keys = new Set();
      while (body[at] !== 101) {
        const key = string(); const hex = key.toString('hex');
        if (keys.has(hex)) bad(); keys.add(hex);
        const start = at; walk(depth + 1);
        if (depth === 0 && key.equals(Buffer.from('info'))) info = body.subarray(start, at);
      }
      at++;
    } else if (kind === 108) {
      at++; while (body[at] !== 101) walk(depth + 1); at++;
    } else if (kind === 105) {
      const end = body.indexOf(101, at + 1); if (end < 0 || end - at > 22) bad();
      const value = body.toString('ascii', at + 1, end);
      if (!/^(?:0|-?[1-9]\d*)$/.test(value)) bad(); at = end + 1;
    } else string();
  }
  walk(0);
  if (at !== body.length || !info || info[0] !== 100) bad();
  return info;
}
module.exports = { infoSlice };
