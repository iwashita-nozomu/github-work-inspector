#!/usr/bin/env node
// Offline fragment assembly, not a server. Same buildFragment implementation as the host bundle.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--model' || args[2] !== '--out') throw new Error('Usage: --model MODEL.json --out VIEW.html');
const prefix = path.join(root, 'plugins/github-work-inspector-chat/skills/github-repo-review-chat/references');
const bundle = fs.readFileSync(path.join(prefix, 'review-selection.js'), 'utf8');
const context = { TextEncoder }; vm.runInNewContext(bundle, context);
const model = JSON.parse(fs.readFileSync(args[1], 'utf8'));
const html = context.GitHubReviewOverview.buildFragment(fs.readFileSync(path.join(prefix, 'overview.fragment.html'), 'utf8'), bundle, model);
fs.writeFileSync(args[3], html, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ native_display_performed: false, file_created: true }));
