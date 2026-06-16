import readline from 'node:readline'
import config from '../config.js'
import { sqlite } from './connection.js'
import { setPasswordByUsername } from '../services/accountService.js'

/**
 * Offline password-reset CLI: `npm run reset-password [username]`.
 *
 * The in-app change-password form needs the current password; this is the
 * recovery path for a fully forgotten / locked-out login. It is deliberately
 * offline only (never exposed over the API) and writes directly to the live
 * database, so run it on the host with the same ENCRYPTION_SECRET as the server.
 */
const MIN_LENGTH = 10

async function main () {
  const users = sqlite.prepare('SELECT username FROM users ORDER BY username').all()
  if (!users.length) {
    console.error('No users exist yet — run `npm run seed` first.')
    process.exit(1)
  }

  let username = process.argv[2]
  if (!username) {
    console.log('Users:')
    users.forEach(u => console.log(`  - ${u.username}`))
    username = (await prompt('\nUsername to reset: ')).trim()
  }
  if (!users.some(u => u.username === username)) {
    console.error(`No user named "${username}".`)
    process.exit(1)
  }

  const password = await prompt(`New password for "${username}": `, { hidden: true })
  if (password.length < MIN_LENGTH) {
    console.error(`Password must be at least ${MIN_LENGTH} characters.`)
    process.exit(1)
  }
  const confirm = await prompt('Confirm new password: ', { hidden: true })
  if (password !== confirm) {
    console.error('Passwords do not match. Aborted.')
    process.exit(1)
  }

  setPasswordByUsername(username, password)
  console.log(`\nPassword updated for "${username}". (database: ${config.dbPath})`)
  process.exit(0)
}

/** Minimal stdin prompt; `hidden` suppresses echo for password entry. */
function prompt (question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  if (hidden) {
    // Echo the prompt itself, but swallow the characters the user types.
    rl._writeToOutput = str => { if (str.includes(question)) rl.output.write(str) }
  }
  return new Promise(resolve => rl.question(question, answer => {
    rl.close()
    if (hidden) process.stdout.write('\n')
    resolve(answer)
  }))
}

main().catch(err => { console.error(err.message || err); process.exit(1) })
