/**
 * M1 native-module proof: runs INSIDE Electron (`npm run check:native`) and
 * verifies better-sqlite3 loads against Electron's ABI after
 * `npm run rebuild:native` (@electron/rebuild).
 *
 * Prints NATIVE_OK and exits 0 on success; prints the error and exits 1 on
 * any failure (including ABI mismatch, the thing this script exists to catch).
 */
const { app } = require('electron')

app
  .whenReady()
  .then(() => {
    const Database = require('better-sqlite3')
    const db = new Database(':memory:')

    db.exec('CREATE TABLE journal (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL)')
    const insert = db.prepare('INSERT INTO journal (kind, text) VALUES (?, ?)')
    insert.run('dictate', 'hello from electron ' + process.versions.electron)
    insert.run('edit', 'tighten this up')

    const rows = db.prepare('SELECT id, kind, text FROM journal ORDER BY id').all()
    if (rows.length !== 2 || rows[0].kind !== 'dictate') {
      throw new Error('unexpected rows: ' + JSON.stringify(rows))
    }

    // The plan leans on FTS5 (MemoryStore, M5) — verify it's compiled in.
    db.exec("CREATE VIRTUAL TABLE mem USING fts5(text)")
    db.prepare('INSERT INTO mem (text) VALUES (?)').run('working memory smoke test')
    const hit = db.prepare("SELECT text FROM mem WHERE mem MATCH 'memory'").get()
    if (!hit) throw new Error('FTS5 query returned no rows')

    db.close()
    console.log('sqlite ok: rows=' + rows.length + ', fts5 ok, electron=' + process.versions.electron)
    console.log('NATIVE_OK')
    app.exit(0)
  })
  .catch((err) => {
    console.error('NATIVE_CHECK_FAILED:', err)
    app.exit(1)
  })
