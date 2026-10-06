// Same assets as the upstream CI, generated deterministically before bundling.
const fs = require('fs');
const { execFileSync } = require('child_process');
fs.mkdirSync('public/assets/styles', { recursive: true });
const generated = new Map();
// The generator scans stylesDir. A prior generated theme contains temporary
// npm imports which it cannot resolve as source for the next theme. Hold each
// generated output in RAM until all three runs complete instead of rescanning it.
for (const theme of ['dark', 'light', 'cyber']) {
  const output = 'public/assets/styles/' + theme + '.less';
  if (fs.existsSync(output)) fs.unlinkSync(output);
}
for (const theme of ['dark', 'light', 'cyber']) {
  execFileSync(process.execPath, [theme + '.js'], { stdio: 'inherit' });
  const output = 'public/assets/styles/' + theme + '.less';
  if (!fs.existsSync(output)) throw Error('THEME_BUILD_MISSING');
  const body = fs.readFileSync(output);
  if (body.length < 10000 || body.toString().includes('~antd/')) throw Error('THEME_BUILD_INVALID');
  generated.set(output, body); fs.unlinkSync(output);
}
for (const [output, body] of generated) fs.writeFileSync(output, body);
fs.appendFileSync('public/assets/styles/cyber.less', '\n@import url(/api/setting/getBackground.less);\n.body-bg { background:@vt-bg-image; background-position:center; background-size:cover; }\n.login-layout { background:@body-background; }\n');
fs.writeFileSync('public/assets/styles/follow.less', '\n');
