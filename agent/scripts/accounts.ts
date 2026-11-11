// order o4857, o28a6: the Accounts setup and copy as a command. Run it from the app's own folder (the one with package.json), on the PC that holds the CRM sign-in (the Server):
//   node agent/scripts/accounts.ts help
// The logic and its tests are agent/agentic/accounts-cli.ts; this file only connects it to the terminal, the state folder and the real database package. Passwords are typed with no echo
// (never as an argument or an environment variable), and nothing here prints one.
import { createInterface } from 'node:readline'
import path from 'node:path'
import { statePaths } from '../config.ts'
import { createAccountsEmail } from '../agentic/accounts-email.ts'
import { createAccountsImport } from '../agentic/accounts-import.ts'
import { createAccountsCodebases } from '../agentic/accounts-codebases.ts'
import { createCodebaseImport } from '../agentic/accounts-codebase-import.ts'
import { createAccountsPlatforms } from '../agentic/accounts-platforms.ts'
import { runCli, type AdminLogin, type Io } from '../agentic/accounts-cli.ts'
import { createCrmProxy } from '../agentic/crmproxy.ts'

const paths = statePaths()
const proxy = createCrmProxy({ file: paths.crmSession })

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) })
const io: Io = {
  say: line => console.log(line),
  ask: q => new Promise(resolve => rl.question(q, a => resolve(a))),
  askHidden: q =>
    new Promise((resolve, reject) => {
      const stdin = process.stdin
      if (!stdin.isTTY) return reject(new Error('A password is typed in a terminal (no echo). Run this command in one.'))
      process.stdout.write(q)
      rl.pause()
      let typed = ''
      stdin.setRawMode(true)
      stdin.resume()
      stdin.setEncoding('utf8')
      const onData = (chunk: string) => {
        for (const c of chunk) {
          if (c === '\r' || c === '\n' || c === '\u0004') {
            stdin.setRawMode(false)
            stdin.off('data', onData)
            process.stdout.write('\n')
            rl.resume()
            return resolve(typed)
          }
          if (c === '\u0003') process.exit(130)
          if (c === '\u007f' || c === '\b') typed = typed.slice(0, -1)
          else typed += c
        }
      }
      stdin.on('data', onData)
    }),
}

// The package is loaded only when it is used (it is the app's pinned postgres 3.4.8).
const PACKAGE = 'postgres'
const loadPackage = () => import(PACKAGE) as Promise<{ default: (o: Record<string, unknown>) => { begin<T>(fn: (tx: { unsafe(text: string): PromiseLike<unknown> }) => Promise<T>): Promise<T>; end(o?: { timeout?: number }): Promise<void> } }>

async function runSql(login: AdminLogin, text: string): Promise<void> {
  const postgres = (await loadPackage()).default
  const sql = postgres({ host: login.host, port: login.port, database: login.database, username: login.user, password: login.password, ssl: 'require', max: 1, connect_timeout: 15, prepare: false, onnotice: () => {} })
  try {
    // One transaction per file: it all happens or none of it does.
    await sql.begin(async tx => {
      await tx.unsafe(text)
    })
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {})
  }
}

try {
  const code = await runCli(process.argv.slice(2), {
    io,
    dir: paths.agent,
    sqlDir: path.resolve(import.meta.dirname, '..', '..', 'db', 'accounts'),
    runSql,
    importer: args => createAccountsImport({ proxy, dir: paths.agent }).run(args),
    lister: person => createAccountsEmail({ dir: paths.agent }).list(person),
    codebaseImporter: args => createCodebaseImport({ proxy, dir: paths.agent }).run(args),
    codebaseLister: person => createAccountsCodebases({ dir: paths.agent }).list(person),
    platformLister: person => createAccountsPlatforms({ dir: paths.agent }).list(person),
    crmSignedIn: () => proxy.session().signedIn,
    packageThere: () => loadPackage().then(() => true, () => false),
  })
  rl.close()
  process.exit(code)
} catch (e) {
  rl.close()
  // Only the message of OUR errors; never a stack (it could carry a host or a login).
  console.log(e instanceof Error ? e.message : 'Something went wrong.')
  process.exit(1)
}
