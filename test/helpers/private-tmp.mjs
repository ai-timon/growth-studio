// Gives the test process a private temporary folder, removed when it exits: the studio's spool folder
// (lib/spool.js, under os.tmpdir()) and every temporary file of the test land there instead of piling up in /tmp.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'gs-test-'))
for (const k of ['TMPDIR', 'TMP', 'TEMP']) process.env[k] = dir
process.on('exit', () => { rmSync(dir, { recursive: true, force: true }) })
