'use strict';
const fs = require('fs');
const path = require('path');
const I = require('./identity');

// Optional worker-only shadow audit. Read directory/stat metadata, never file
// contents. No path is deletable as a result; H&R/fence/live recheck are separate.
async function auditGroup (group, mappings, options = {}) {
  const deadline = options.deadline || Date.now() + 2000;
  const maxEntries = Math.min(options.maxEntries || 2000, 20000);
  let entries = 0;
  function bound () { if (++entries > maxEntries || Date.now() >= deadline) throw Error('CG_FILE_AUDIT_BOUND'); }
  async function checked (file) {
    bound(); const stat = await fs.promises.lstat(file);
    if (stat.isSymbolicLink()) throw Error('CG_FILE_SYMLINK');
    if (stat.isFile() && stat.nlink !== 1) throw Error('CG_FILE_HARDLINK');
    return stat;
  }
  try {
    if (!group.proved || group.reasons.length || group.paths.length !== 1) throw Error('CG_GROUP_PROTECTED');
    const cp = I.absolute(group.paths[0]);
    const candidates = mappings.filter(m => I.within(cp, I.absolute(m.qbitRoot)));
    if (candidates.length !== 1) throw Error('CG_FILE_MAPPING');
    const mapping = candidates[0];
    if (!path.isAbsolute(mapping.localRoot)) throw Error('CG_FILE_MAPPING');
    const root = path.resolve(mapping.localRoot);
    // Check every ancestor, not only the leaf: a symlink in the mount subtree
    // must not escape the declared read-only filesystem namespace.
    let ancestor = path.parse(root).root;
    for (const part of root.slice(ancestor.length).split(path.sep).filter(Boolean)) { ancestor = path.join(ancestor, part); await checked(ancestor); }
    const relative = cp.slice(mapping.qbitRoot.length).replace(/^\//, '');
    let local = root;
    for (const part of relative.split('/').filter(Boolean)) { I.absolute('/' + part); local = path.join(local, part); await checked(local); }
    const expected = new Map(group.files.map(([f, size]) => {
      if (!I.within(f, cp)) throw Error('CG_FILE_MAPPING');
      return [path.join(root, f.slice(mapping.qbitRoot.length).replace(/^\//, '')), size];
    }));
    const found = new Set(); let logicalBytes = 0;
    async function walk (p) {
      const stat = await checked(p);
      if (stat.isFile()) {
        if (!expected.has(p) || stat.size > expected.get(p)) throw Error('CG_UNMANAGED_OR_OVERSIZE_FILE');
        found.add(p); logicalBytes += stat.size; return;
      }
      if (!stat.isDirectory()) throw Error('CG_FILE_TYPE');
      // opendir streams names; unlike readdir it never allocates an unbounded
      // directory listing before the entry/deadline guard can be checked.
      const directory = await fs.promises.opendir(p);
      for await (const child of directory) { bound(); await walk(path.join(p, child.name)); }
    }
    await walk(local);
    if (found.size !== expected.size) throw Error('CG_FILE_MISSING');
    return { ok: true, entries, logicalBytes, deleteAuthorized: false };
  } catch (e) {
    return { ok: false, entries, code: /^CG_[A-Z_]+$/.test(e.message) ? e.message : 'CG_FILE_UNAVAILABLE', deleteAuthorized: false };
  }
}
module.exports = { auditGroup };
