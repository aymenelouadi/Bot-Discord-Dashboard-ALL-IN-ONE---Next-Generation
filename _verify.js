/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

// Quick syntax verify
const toCheck = [
  'commands/_protectionHelper.js',
  'commands/anti_ban.js',
  'commands/anti_kick.js',
  'commands/anti_bots.js',
  'commands/anti_webhooks.js',
  'commands/anti_channel_create.js',
  'commands/anti_channel_delete.js',
  'commands/anti_role_add.js',
  'commands/anti_role_delete.js',
  'systems/protection.js',
];
let ok=0, err=0;
for (const f of toCheck) {
  try { require('./'+f); console.log('✅', f); ok++; }
  catch(e) { console.log('❌', f, '→', e.message); err++; }
}
console.log(`\n${ok} OK, ${err} ERRORS`);
process.exit(err > 0 ? 1 : 0);


/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */