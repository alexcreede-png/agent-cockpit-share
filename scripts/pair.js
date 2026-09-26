#!/usr/bin/env node
'use strict';
// Pair a phone with the cockpit, list paired phones, or revoke them. Run on the Mac:
//   npm run pair                 print a one-time code (valid 10 minutes) to type on the phone
//   npm run pair -- list         show paired devices
//   npm run pair -- revoke <id>  unpair one device ("all" unpairs every device)
const config = require('../lib/config').load();
const pairing = require('../lib/pairing');

const devices = pairing.store(config.stateDir);
const [cmd = 'code', arg] = process.argv.slice(2);

if (cmd === 'code') {
  const { code, expires } = devices.newCode();
  const pretty = code.slice(0, 4) + '-' + code.slice(4);
  console.log(`Pair code: ${pretty}`);
  console.log(`Open the cockpit on your phone and enter it before ${new Date(expires).toLocaleTimeString()}. It works once.`);
} else if (cmd === 'list') {
  const list = devices.list();
  if (!list.length) console.log('No paired devices.');
  for (const d of list) console.log(`${d.id}  ${d.created}  ${d.label}`);
} else if (cmd === 'revoke' && arg) {
  console.log(`Revoked ${devices.revoke(arg)} device(s).`);
} else {
  console.error('usage: npm run pair [-- list | -- revoke <id|all>]');
  process.exit(2);
}
