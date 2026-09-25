// Turn dist-single/blackwater.html into a page fragment for hosts that supply their own
// <!doctype>/<head>/<body> skeleton: title first, then fonts, styles, the app root and script.
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.resolve('dist-single/blackwater.html'), 'utf8');
const pick = (re, name) => {
  const m = src.match(re);
  if (!m) throw new Error(`missing ${name}`);
  return m[0];
};
const title = pick(/<title>[\s\S]*?<\/title>/, 'title');
const desc = pick(/<meta name="description"[^>]*>/, 'description');
const fonts = pick(/<link\s+rel="stylesheet"\s+href="https:\/\/fonts\.googleapis\.com[^>]*>/, 'fonts');
const style = pick(/<style>[\s\S]*?<\/style>/, 'style');
const script = pick(/<script type="module">[\s\S]*<\/script>/, 'script');
const out = [
  title,
  desc,
  '<link rel="preconnect" href="https://fonts.googleapis.com" />',
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />',
  fonts,
  style,
  '<div id="app"></div>',
  script,
  '',
].join('\n');
const file = path.resolve('dist-single/blackwater-page.html');
fs.writeFileSync(file, out);
console.log(`wrote ${file} (${(out.length / 1024 / 1024).toFixed(2)} MB)`);
