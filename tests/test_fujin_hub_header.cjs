const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../fujin/FUJIN.html'), 'utf8');
const header = html.match(/<header>([\s\S]*?)<\/header>/)?.[1];
assert.ok(header, 'FUJIN header exists');

const menu = header.match(/<div class="account-menu" id="account-menu" hidden>([\s\S]*?)<\/div>/)?.[1];
assert.ok(menu, 'account controls exist');
assert.ok(!header.slice(0, header.indexOf('<div class="brand">')).includes('hub-home'), 'HUB is not beside the menu button');
assert.ok(menu.indexOf('class="hub-home"') < menu.indexOf('id="account-btn"'), 'HUB is beside and before the account button');
assert.match(menu, /href="\.\.\/hanaoka_hub\.html"/);
assert.match(menu, /aria-label="HANAOKA HUBへ戻る"/);
assert.match(html, /\.account-menu\[hidden\] \{ display:none; \}/, 'group stays hidden before authentication');
assert.match(html, /\.account-menu \{[^}]*order:99;/, 'the HUB/account group is at the right on PC');
assert.match(html, /header \.meta-info \{ margin-left:auto;/, 'PC header pushes right-side controls to the edge');
assert.match(menu, /<span class="hub-home-label">HUB<\/span>/, 'PC keeps the HUB text label');
assert.match(html, /\.account-menu \.hub-home-label \{ display:none; \}/, 'mobile uses the house icon');

console.log('FUJIN HUB header placement checks passed');
