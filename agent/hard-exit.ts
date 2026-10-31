import { createRequire } from 'node:module'
import type * as Koffi from 'koffi'

// F-058: ending the process must not wait for anything. process.exit() first joins the worker threads,
// and a worker that sits in a call into Windows that does not come back (the text-focus worker asking
// an app that hangs, the key grab) holds the exit for as long as that call lasts - and when it finally
// returns, the exit code is lost. Measured on 1 Nov 2026, a worker in kernel32!Sleep(10 s) and the main
// thread calling process.exit(75): the process ended after 10.5 s with code 3221226505 (0xC0000409),
// not 75; with TerminateProcess on itself: after 0.4 s with code 75. That is what happened at 23:37 on
// 31 Oct when Update now was pressed: the agent logged "stopped" and never exited, so Start.cmd, waiting
// for the code 75 that starts the update, waited with it.
// Everything the agent has to close is closed before this is called (main.ts `shutdown`); this only
// ends the process, at once, with the code it was given.

export function hardExit(code: number): never {
  if (process.platform === 'win32') {
    try {
      const koffi = createRequire(import.meta.url)('koffi') as typeof Koffi
      const kernel = koffi.load('kernel32.dll')
      const self = kernel.func('void * __stdcall GetCurrentProcess()')
      const end = kernel.func('bool __stdcall TerminateProcess(void *process, uint32 code)')
      end(self(), code >>> 0)
    } catch {
      // No koffi here: the ordinary exit below.
    }
  }
  return process.exit(code)
}
