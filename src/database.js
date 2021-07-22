/**
 * database.js
 *
 * Layer between the database and the application
 */

const Sqlite3Database = require('better-sqlite3')
const { DEFAULT_TRUSTLIST } = require('./config')
const Run = require('run-sdk')

// ------------------------------------------------------------------------------------------------
// Globals
// ------------------------------------------------------------------------------------------------

const HEIGHT_MEMPOOL = -1
const HEIGHT_UNKNOWN = null

// ------------------------------------------------------------------------------------------------
// Database
// ------------------------------------------------------------------------------------------------

class Database {
  constructor (path, logger) {
    this.path = path
    this.logger = logger
    this.db = null
    this.trustlist = new Set()
    this.banlist = new Set()

    this.onReadyToExecute = null
    this.onAddTransaction = null
    this.onDeleteTransaction = null
    this.onTrustTransaction = null
    this.onUntrustTransaction = null
    this.onBanTransaction = null
    this.onUnbanTransaction = null
    this.onUntrustTransaction = null
  }

  open () {
    if (this.db) throw new Error('Database already open')

    this.db = new Sqlite3Database(this.path)

    // 100MB cache
    this.db.pragma('cache_size = 6400')
    this.db.pragma('page_size = 16384')

    // WAL mode allows simultaneous readers
    this.db.pragma('journal_mode = WAL')

    // Synchronizes WAL at checkpoints
    this.db.pragma('synchronous = NORMAL')

    // Initialise and perform upgrades
    this.initializeV1()
    this.initializeV2()
    this.initializeV3()

    const setupCrawlStmt = this.db.prepare('INSERT OR IGNORE INTO crawl (role, height, hash) VALUES (\'tip\', 0, NULL)')
    const trustIfMissingStmt = this.db.prepare('INSERT OR IGNORE INTO trust (txid, value) VALUES (?, 1)')

    this.transaction(() => {
      setupCrawlStmt.run()
      for (const txid of DEFAULT_TRUSTLIST) {
        trustIfMissingStmt.run(txid)
      }
    })

    this.addNewTransactionStmt = this.db.prepare('INSERT OR IGNORE INTO tx (txid, height, time, bytes, has_code, executable, executed, indexed) VALUES (?, null, ?, null, 0, 0, 0, 0)')
    this.setTransactionBytesStmt = this.db.prepare('UPDATE tx SET bytes = ? WHERE txid = ?')
    this.setTransactionExecutableStmt = this.db.prepare('UPDATE tx SET executable = ? WHERE txid = ?')
    this.setTransactionTimeStmt = this.db.prepare('UPDATE tx SET time = ? WHERE txid = ?')
    this.setTransactionHeightStmt = this.db.prepare(`UPDATE tx SET height = ? WHERE txid = ? AND (height IS NULL OR height = ${HEIGHT_MEMPOOL})`)
    this.setTransactionHasCodeStmt = this.db.prepare('UPDATE tx SET has_code = ? WHERE txid = ?')
    this.setTransactionExecutedStmt = this.db.prepare('UPDATE tx SET executed = ? WHERE txid = ?')
    this.setTransactionIndexedStmt = this.db.prepare('UPDATE tx SET indexed = ? WHERE txid = ?')
    this.hasTransactionStmt = this.db.prepare('SELECT txid FROM tx WHERE txid = ?')
    this.getTransactionHexStmt = this.db.prepare('SELECT LOWER(HEX(bytes)) AS hex FROM tx WHERE txid = ?')
    this.getTransactionTimeStmt = this.db.prepare('SELECT time FROM tx WHERE txid = ?')
    this.getTransactionHeightStmt = this.db.prepare('SELECT height FROM tx WHERE txid = ?')
    this.getTransactionHasCodeStmt = this.db.prepare('SELECT has_code FROM tx WHERE txid = ?')
    this.getTransactionIndexedStmt = this.db.prepare('SELECT indexed FROM tx WHERE txid = ?')
    this.getTransactionFailedStmt = this.db.prepare('SELECT (executed = 1 AND indexed = 0) AS failed FROM tx WHERE txid = ?')
    this.getTransactionDownloadedStmt = this.db.prepare('SELECT bytes IS NOT NULL AS downloaded FROM tx WHERE txid = ?')
    this.deleteTransactionStmt = this.db.prepare('DELETE FROM tx WHERE txid = ?')
    this.unconfirmTransactionStmt = this.db.prepare(`UPDATE tx SET height = ${HEIGHT_MEMPOOL} WHERE txid = ?`)
    this.getTransactionsAboveHeightStmt = this.db.prepare('SELECT txid FROM tx WHERE height > ?')
    this.getMempoolTransactionsBeforeTimeStmt = this.db.prepare(`SELECT txid FROM tx WHERE height = ${HEIGHT_MEMPOOL} AND time < ?`)
    this.getTransactionsToDownloadStmt = this.db.prepare('SELECT txid FROM tx WHERE bytes IS NULL')
    this.getTransactionsDownloadedCountStmt = this.db.prepare('SELECT COUNT(*) AS count FROM tx WHERE bytes IS NOT NULL')
    this.getTransactionsIndexedCountStmt = this.db.prepare('SELECT COUNT(*) AS count FROM tx WHERE indexed = 1')
    this.isReadyToExecuteStmt = this.db.prepare(`
      SELECT (
        bytes IS NOT NULL
        AND executable = 1
        AND executed = 0
        AND (has_code = 0 OR (SELECT COUNT(*) FROM trust WHERE trust.txid = tx.txid AND trust.value = 1) = 1)
        AND txid NOT IN ban
        AND (
          SELECT COUNT(*)
          FROM tx AS tx2
          JOIN deps
          ON deps.up = tx2.txid
          WHERE deps.down = tx.txid
          AND (tx2.bytes IS NULL OR (tx2.executable = 1 AND tx2.executed = 0))
        ) = 0
      ) AS ready 
      FROM tx
      WHERE txid = ?
    `)
    this.getDownstreamReadyToExecute = this.db.prepare(`
      SELECT down
      FROM deps
      JOIN tx
      ON tx.txid = deps.down
      WHERE up = ?
      AND bytes IS NOT NULL
      AND executable = 1
      AND executed = 0
      AND (has_code = 0 OR (SELECT COUNT(*) FROM trust WHERE trust.txid = tx.txid AND trust.value = 1) = 1)
      AND txid NOT IN ban
      AND (
        SELECT COUNT(*)
        FROM tx AS tx2
        JOIN deps
        ON deps.up = tx2.txid
        WHERE deps.down = tx.txid
        AND (tx2.bytes IS NULL OR (tx2.executable = 1 AND tx2.executed = 0))
      ) = 0
    `)

    this.setSpendStmt = this.db.prepare('INSERT OR REPLACE INTO spends (location, spend_txid) VALUES (?, ?)')
    this.setUnspentStmt = this.db.prepare('INSERT OR IGNORE INTO spends (location, spend_txid) VALUES (?, null)')
    this.getSpendStmt = this.db.prepare('SELECT spend_txid FROM spends WHERE location = ?')
    this.unspendOutputsStmt = this.db.prepare('UPDATE spends SET spend_txid = null WHERE spend_txid = ?')
    this.deleteSpendsStmt = this.db.prepare('DELETE FROM spends WHERE location LIKE ? || \'%\'')

    this.addDepStmt = this.db.prepare('INSERT OR IGNORE INTO deps (up, down) VALUES (?, ?)')
    this.deleteDepsStmt = this.db.prepare('DELETE FROM deps WHERE down = ?')
    this.getDownstreamStmt = this.db.prepare('SELECT down FROM deps WHERE up = ?')
    this.getUpstreamUnexecutedCodeStmt = this.db.prepare(`
      SELECT txdeps.txid as txid
      FROM (SELECT up AS txid FROM deps WHERE down = ?) as txdeps
      JOIN tx ON tx.txid = txdeps.txid
      WHERE tx.executable = 1 AND tx.executed = 0 AND tx.has_code = 1
    `)

    this.setJigStateStmt = this.db.prepare('INSERT OR IGNORE INTO jig (location, state, class, lock, scripthash) VALUES (?, ?, null, null, null)')
    this.setJigClassStmt = this.db.prepare('UPDATE jig SET class = ? WHERE location = ?')
    this.setJigLockStmt = this.db.prepare('UPDATE jig SET lock = ? WHERE location = ?')
    this.setJigScripthashStmt = this.db.prepare('UPDATE jig SET scripthash = ? WHERE location = ?')
    this.getJigStateStmt = this.db.prepare('SELECT state FROM jig WHERE location = ?')
    this.deleteJigStatesStmt = this.db.prepare('DELETE FROM jig WHERE location LIKE ? || \'%\'')

    const getAllUnspentSql = `
      SELECT spends.location AS location FROM spends
      JOIN jig ON spends.location = jig.location
      WHERE spends.spend_txid IS NULL`
    this.getAllUnspentStmt = this.db.prepare(getAllUnspentSql)
    this.getAllUnspentByClassStmt = this.db.prepare(`${getAllUnspentSql} AND jig.class = ?`)
    this.getAllUnspentByLockStmt = this.db.prepare(`${getAllUnspentSql} AND jig.lock = ?`)
    this.getAllUnspentByScripthashStmt = this.db.prepare(`${getAllUnspentSql} AND jig.scripthash = ?`)
    this.getAllUnspentByClassLockStmt = this.db.prepare(`${getAllUnspentSql} AND jig.class = ? AND lock = ?`)
    this.getAllUnspentByClassScripthashStmt = this.db.prepare(`${getAllUnspentSql} AND jig.class = ? AND scripthash = ?`)
    this.getAllUnspentByLockScripthashStmt = this.db.prepare(`${getAllUnspentSql} AND jig.lock = ? AND scripthash = ?`)
    this.getAllUnspentByClassLockScripthashStmt = this.db.prepare(`${getAllUnspentSql} AND jig.class = ? AND jig.lock = ? AND scripthash = ?`)
    this.getNumUnspentStmt = this.db.prepare('SELECT COUNT(*) as unspent FROM spends JOIN jig ON spends.location = jig.location WHERE spends.spend_txid IS NULL')

    this.setBerryStateStmt = this.db.prepare('INSERT OR IGNORE INTO berry (location, state) VALUES (?, ?)')
    this.getBerryStateStmt = this.db.prepare('SELECT state FROM berry WHERE location = ?')
    this.deleteBerryStatesStmt = this.db.prepare('DELETE FROM berry WHERE location LIKE ? || \'%\'')

    this.setTrustedStmt = this.db.prepare('INSERT OR REPLACE INTO trust (txid, value) VALUES (?, ?)')
    this.getTrustlistStmt = this.db.prepare('SELECT txid FROM trust WHERE value = 1')

    this.banStmt = this.db.prepare('INSERT OR REPLACE INTO ban (txid) VALUES (?)')
    this.unbanStmt = this.db.prepare('DELETE FROM ban WHERE txid = ?')
    this.getBanlistStmt = this.db.prepare('SELECT txid FROM ban')

    this.getHeightStmt = this.db.prepare('SELECT height FROM crawl WHERE role = \'tip\'')
    this.getHashStmt = this.db.prepare('SELECT hash FROM crawl WHERE role = \'tip\'')
    this.setHeightAndHashStmt = this.db.prepare('UPDATE crawl SET height = ?, hash = ? WHERE role = \'tip\'')

    this._loadTrustlist()
    this._loadBanlist()
    this._loadUnexecuted()
  }

  initializeV1 () {
    if (this.db.pragma('user_version')[0].user_version !== 0) return

    this.logger.info('Setting up database v1')

    this.transaction(() => {
      this.db.pragma('user_version = 1')

      this.db.prepare(
        `CREATE TABLE IF NOT EXISTS tx (
          txid TEXT NOT NULL,
          height INTEGER,
          time INTEGER,
          hex TEXT,
          has_code INTEGER,
          executable INTEGER,
          executed INTEGER,
          indexed INTEGER,
          UNIQUE(txid)
        )`
      ).run()

      this.db.prepare(
        `CREATE TABLE IF NOT EXISTS spends (
          location TEXT NOT NULL PRIMARY KEY,
          spend_txid TEXT
        ) WITHOUT ROWID`
      ).run()

      this.db.prepare(
        `CREATE TABLE IF NOT EXISTS deps (
          up TEXT NOT NULL,
          down TEXT NOT NULL,
          UNIQUE(up, down)
        )`
      ).run()

      this.db.prepare(
        `CREATE TABLE IF NOT EXISTS jig (
          location TEXT NOT NULL PRIMARY KEY,
          state TEXT NOT NULL,
          class TEXT,
          scripthash TEXT,
          lock TEXT
        ) WITHOUT ROWID`
      ).run()

      this.db.prepare(
        `CREATE TABLE IF NOT EXISTS berry (
          location TEXT NOT NULL PRIMARY KEY,
          state TEXT NOT NULL
        ) WITHOUT ROWID`
      ).run()

      this.db.prepare(
        `CREATE TABLE IF NOT EXISTS trust (
          txid TEXT NOT NULL PRIMARY KEY,
          value INTEGER
        ) WITHOUT ROWID`
      ).run()

      this.db.prepare(
        `CREATE TABLE IF NOT EXISTS ban (
          txid TEXT NOT NULL PRIMARY KEY
        ) WITHOUT ROWID`
      ).run()

      this.db.prepare(
        `CREATE TABLE IF NOT EXISTS crawl (
          role TEXT UNIQUE,
          height INTEGER,
          hash TEXT
        )`
      ).run()

      this.db.prepare(
        'CREATE INDEX IF NOT EXISTS tx_txid_index ON tx (txid)'
      ).run()

      this.db.prepare(
        'CREATE INDEX IF NOT EXISTS jig_index ON jig (class)'
      ).run()
    })
  }

  initializeV2 () {
    if (this.db.pragma('user_version')[0].user_version !== 1) return

    this.logger.info('Setting up database v2')

    this.transaction(() => {
      this.db.pragma('user_version = 2')

      this.db.prepare(
        `CREATE TABLE tx_v2 (
          txid TEXT NOT NULL,
          height INTEGER,
          time INTEGER,
          bytes BLOB,
          has_code INTEGER,
          executable INTEGER,
          executed INTEGER,
          indexed INTEGER
        )`
      ).run()

      const txids = this.db.prepare('SELECT txid FROM tx').all().map(row => row.txid)
      const gettx = this.db.prepare('SELECT * FROM tx WHERE txid = ?')
      const insert = this.db.prepare('INSERT INTO tx_v2 (txid, height, time, bytes, has_code, executable, executed, indexed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')

      this.logger.info('Migrating data')
      for (const txid of txids) {
        const row = gettx.get(txid)
        const bytes = row.hex ? Buffer.from(row.hex, 'hex') : null
        insert.run(row.txid, row.height, row.time, bytes, row.has_code, row.executable, row.executed, row.indexed)
      }

      this.db.prepare(
        'DROP INDEX tx_txid_index'
      ).run()

      this.db.prepare(
        'DROP TABLE tx'
      ).run()

      this.db.prepare(
        'ALTER TABLE tx_v2 RENAME TO tx'
      ).run()

      this.db.prepare(
        'CREATE INDEX IF NOT EXISTS tx_txid_index ON tx (txid)'
      ).run()

      this.logger.info('Saving results')
    })

    this.logger.info('Optimizing database')
    this.db.prepare('VACUUM').run()
  }

  initializeV3 () {
    if (this.db.pragma('user_version')[0].user_version !== 2) return

    this.logger.info('Setting up database v3')

    this.transaction(() => {
      this.db.pragma('user_version = 3')

      this.db.prepare('CREATE INDEX IF NOT EXISTS deps_up_index ON deps (up)').run()
      this.db.prepare('CREATE INDEX IF NOT EXISTS deps_down_index ON deps (down)').run()
      this.db.prepare('CREATE INDEX IF NOT EXISTS trust_txid_index ON trust (txid)').run()

      this.logger.info('Saving results')
    })
  }

  close () {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  transaction (f) {
    if (!this.db) return
    this.db.transaction(f)()
  }

  // --------------------------------------------------------------------------
  // tx
  // --------------------------------------------------------------------------

  addNewTransaction (txid) {
    if (this.hasTransaction(txid)) return

    const time = Math.round(Date.now() / 1000)

    this.addNewTransactionStmt.run(txid, time)

    if (this.onAddTransaction) this.onAddTransaction(txid)
  }

  setTransactionHeight (txid, height) {
    this.setTransactionHeightStmt.run(height, txid)
  }

  setTransactionTime (txid, time) {
    this.setTransactionTimeStmt.run(time, txid)
  }

  storeParsedNonExecutableTransaction (txid, hex, inputs, outputs) {
    this.transaction(() => {
      const bytes = Buffer.from(hex, 'hex')
      this.setTransactionBytesStmt.run(bytes, txid)
      this.setTransactionExecutableStmt.run(0, txid)

      inputs.forEach(location => this.setSpendStmt.run(location, txid))
      outputs.forEach(location => this.setUnspentStmt.run(location))
    })

    // Non-executable might be berry data. We execute once we receive them.
    if (this.onReadyToExecute) {
      const downstreamReadyToExecute = this.getDownstreamReadyToExecute.raw(true).all(txid).map(x => x[0])
      downstreamReadyToExecute.forEach(txid => this.onReadyToExecute(txid))
    }
  }

  storeParsedExecutableTransaction (txid, hex, hasCode, deps, inputs, outputs) {
    this.transaction(() => {
      const bytes = Buffer.from(hex, 'hex')
      this.setTransactionBytesStmt.run(bytes, txid)
      this.setTransactionExecutableStmt.run(1, txid)
      this.setTransactionHasCodeStmt.run(hasCode ? 1 : 0, txid)

      inputs.forEach(location => this.setSpendStmt.run(location, txid))
      outputs.forEach(location => this.setUnspentStmt.run(location))

      for (const deptxid of deps) {
        this.addNewTransaction(deptxid)
        this.addDepStmt.run(deptxid, txid)

        if (this.getTransactionFailedStmt.get(deptxid).failed) {
          this.setTransactionExecutionFailed(txid)
          return
        }
      }
    })

    this._checkExecutability(txid)
  }

  storeExecutedTransaction (txid, result) {
    const { cache, classes, locks, scripthashes } = result

    this.transaction(() => {
      this.setTransactionExecutedStmt.run(1, txid)
      this.setTransactionIndexedStmt.run(1, txid)

      for (const key of Object.keys(cache)) {
        if (key.startsWith('jig://')) {
          const location = key.slice('jig://'.length)
          this.setJigStateStmt.run(location, JSON.stringify(cache[key]))
          continue
        }

        if (key.startsWith('berry://')) {
          const location = key.slice('berry://'.length)
          this.setBerryStateStmt.run(location, JSON.stringify(cache[key]))
          continue
        }
      }

      for (const [location, cls] of classes) {
        this.setJigClassStmt.run(cls, location)
      }

      for (const [location, lock] of locks) {
        this.setJigLockStmt.run(lock, location)
      }

      for (const [location, scripthash] of scripthashes) {
        this.setJigScripthashStmt.run(scripthash, location)
      }
    })

    if (this.onReadyToExecute) {
      const downstreamReadyToExecute = this.getDownstreamReadyToExecute.raw(true).all(txid).map(x => x[0])
      downstreamReadyToExecute.forEach(txid => this.onReadyToExecute(txid))
    }
  }

  setTransactionExecutionFailed (txid) {
    this.transaction(() => {
      this.setTransactionExecutableStmt.run(0, txid)
      this.setTransactionExecutedStmt.run(1, txid)
      this.setTransactionIndexedStmt.run(0, txid)
    })

    // We try executing downstream transactions if this was marked executable but it wasn't.
    // This allows an admin to manually change executable status in the database.

    let executable = false
    try {
      const rawtx = this.getTransactionHex(txid)
      Run.util.metadata(rawtx)
      executable = true
    } catch (e) { }

    if (!executable) {
      const downstream = this.getDownstreamStmt.raw(true).all(txid).map(x => x[0])
      downstream.forEach(downtxid => this._checkExecutability(downtxid))
    }
  }

  getTransactionHex (txid) {
    const row = this.getTransactionHexStmt.raw(true).get(txid)
    return row && row[0]
  }

  getTransactionTime (txid) {
    const row = this.getTransactionTimeStmt.raw(true).get(txid)
    return row && row[0]
  }

  getTransactionHeight (txid) {
    const row = this.getTransactionHeightStmt.raw(true).get(txid)
    return row && row[0]
  }

  deleteTransaction (txid, deleted = new Set()) {
    if (deleted.has(txid)) return
    deleted.add(txid)

    this.transaction(() => {
      this.deleteTransactionStmt.run(txid)
      this.deleteJigStatesStmt.run(txid)
      this.deleteBerryStatesStmt.run(txid)
      this.deleteSpendsStmt.run(txid)
      this.unspendOutputsStmt.run(txid)
      this.deleteDepsStmt.run(txid)

      if (this.onDeleteTransaction) this.onDeleteTransaction(txid)

      const downtxids = this.getDownstreamStmt.raw(true).all(txid).map(row => row[0])
      downtxids.forEach(downtxid => this.deleteTransaction(downtxid, deleted))
    })
  }

  unconfirmTransaction (txid) {
    this.unconfirmTransactionStmt.run(txid)
  }

  unindexTransaction (txid) {
    this.transaction(() => {
      if (this.getTransactionIndexedStmt.raw(true).get(txid)[0]) {
        this.setTransactionExecutedStmt.run(0, txid)
        this.setTransactionIndexedStmt.run(0, txid)
        this.deleteJigStatesStmt.run(txid)
        this.deleteBerryStatesStmt.run(txid)

        const downtxids = this.getDownstreamStmt.raw(true).all(txid).map(row => row[0])
        downtxids.forEach(downtxid => this.unindexTransaction(downtxid))

        if (this.onUnindexTransaction) this.onUnindexTransaction(txid)
      }
    })
  }

  hasTransaction (txid) { return !!this.hasTransactionStmt.get(txid) }
  isTransactionDownloaded (txid) { return !!this.getTransactionDownloadedStmt.raw(true).get(txid)[0] }
  getTransactionsAboveHeight (height) { return this.getTransactionsAboveHeightStmt.raw(true).all(height).map(row => row[0]) }
  getMempoolTransactionsBeforeTime (time) { return this.getMempoolTransactionsBeforeTimeStmt.raw(true).all(time).map(row => row[0]) }
  getTransactionsToDownload () { return this.getTransactionsToDownloadStmt.raw(true).all().map(row => row[0]) }
  getDownloadedCount () { return this.getTransactionsDownloadedCountStmt.get().count }
  getIndexedCount () { return this.getTransactionsIndexedCountStmt.get().count }

  // --------------------------------------------------------------------------
  // spends
  // --------------------------------------------------------------------------

  getSpend (location) {
    const row = this.getSpendStmt.raw(true).get(location)
    return row && row[0]
  }

  // --------------------------------------------------------------------------
  // deps
  // --------------------------------------------------------------------------

  addDep (txid, deptxid) {
    this.addNewTransaction(deptxid)

    this.addDepStmt.run(deptxid, txid)

    if (this.getTransactionFailedStmt.get(deptxid).failed) {
      this.setTransactionExecutionFailed(deptxid)
    }
  }

  addMissingDeps (txid, deptxids) {
    this.transaction(() => deptxids.forEach(deptxid => this.addDep(txid, deptxids)))

    this._checkExecutability(txid)
  }

  // --------------------------------------------------------------------------
  // jig
  // --------------------------------------------------------------------------

  getJigState (location) {
    const row = this.getJigStateStmt.raw(true).get(location)
    return row && row[0]
  }

  // --------------------------------------------------------------------------
  // unspent
  // --------------------------------------------------------------------------

  getAllUnspent () {
    return this.getAllUnspentStmt.raw(true).all().map(row => row[0])
  }

  getAllUnspentByClassOrigin (origin) {
    return this.getAllUnspentByClassStmt.raw(true).all(origin).map(row => row[0])
  }

  getAllUnspentByLockOrigin (origin) {
    return this.getAllUnspentByLockStmt.raw(true).all(origin).map(row => row[0])
  }

  getAllUnspentByScripthash (scripthash) {
    return this.getAllUnspentByScripthashStmt.raw(true).all(scripthash).map(row => row[0])
  }

  getAllUnspentByClassOriginAndLockOrigin (clsOrigin, lockOrigin) {
    return this.getAllUnspentByClassLockStmt.raw(true).all(clsOrigin, lockOrigin).map(row => row[0])
  }

  getAllUnspentByClassOriginAndScripthash (clsOrigin, scripthash) {
    return this.getAllUnspentByClassScripthashStmt.raw(true).all(clsOrigin, scripthash).map(row => row[0])
  }

  getAllUnspentByLockOriginAndScripthash (lockOrigin, scripthash) {
    return this.getAllUnspentByLockScripthashStmt.raw(true).all(lockOrigin, scripthash).map(row => row[0])
  }

  getAllUnspentByClassOriginAndLockOriginAndScripthash (clsOrigin, lockOrigin, scripthash) {
    return this.getAllUnspentByClassLockScripthashStmt.raw(true).all(clsOrigin, lockOrigin, scripthash).map(row => row[0])
  }

  getNumUnspent () {
    return this.getNumUnspentStmt.get().unspent
  }

  // --------------------------------------------------------------------------
  // berry
  // --------------------------------------------------------------------------

  getBerryState (location) {
    const row = this.getBerryStateStmt.raw(true).get(location)
    return row && row[0]
  }

  // --------------------------------------------------------------------------
  // trust
  // --------------------------------------------------------------------------

  isTrusted (txid) {
    return this.trustlist.has(txid)
  }

  trust (txid) {
    if (this.trustlist.has(txid)) return

    const trusted = [txid]

    // Recursively trust code parents
    const queue = this.getUpstreamUnexecutedCodeStmt.raw(true).all(txid).map(x => x[0])
    const visited = new Set()
    while (queue.length) {
      const uptxid = queue.shift()
      if (visited.has(uptxid)) continue
      if (this.trustlist.has(uptxid)) continue
      visited.add(uptxid)
      trusted.push(txid)
      this.getUpstreamUnexecutedCodeStmt.raw(true).all(txid).forEach(x => queue.push(x[0]))
    }

    this.transaction(() => {
      trusted.forEach(txid => this.setTrustedStmt.run(txid, 1))
      trusted.forEach(txid => this.trustlist.add(txid))
    })

    trusted.forEach(txid => this._checkExecutability(txid))

    if (this.onTrustTransaction) trusted.forEach(txid => this.onTrustTransaction(txid))
  }

  untrust (txid) {
    if (!this.trustlist.has(txid)) return
    this.transaction(() => {
      this.unindexTransaction(txid)
      this.setTrustedStmt.run(txid, 0)
    })
    this.trustlist.delete(txid)
    if (this.onUntrustTransaction) this.onUntrustTransaction(txid)
  }

  getTrustlist () {
    return Array.from(this.trustlist)
  }

  // --------------------------------------------------------------------------
  // ban
  // --------------------------------------------------------------------------

  isBanned (txid) {
    return this.banlist.has(txid)
  }

  ban (txid) {
    if (this.banlist.has(txid)) return
    this.transaction(() => {
      this.unindexTransaction(txid)
      this.banStmt.run(txid)
    })
    this.banlist.add(txid)
    if (this.onBanTransaction) this.onBanTransaction(txid)
  }

  unban (txid) {
    if (!this.banlist.has(txid)) return
    this.unbanStmt.run(txid)
    this.banlist.delete(txid)
    this._checkExecutability(txid)
    if (this.onUnbanTransaction) this.onUnbanTransaction(txid)
  }

  getBanlist () {
    return Array.from(this.banlist)
  }

  // --------------------------------------------------------------------------
  // crawl
  // --------------------------------------------------------------------------

  getHeight () {
    const row = this.getHeightStmt.raw(true).all()[0]
    return row && row[0]
  }

  getHash () {
    const row = this.getHashStmt.raw(true).all()[0]
    return row && row[0]
  }

  setHeightAndHash (height, hash) {
    this.setHeightAndHashStmt.run(height, hash)
  }

  // --------------------------------------------------------------------------
  // internal
  // --------------------------------------------------------------------------

  _loadTrustlist () {
    this.getTrustlistStmt.raw(true).all().forEach(row => this.trustlist.add(row[0]))
  }

  _loadBanlist () {
    this.getBanlistStmt.raw(true).all().forEach(row => this.banlist.add(row[0]))
  }

  _loadUnexecuted () {
    const { Worker } = require('worker_threads')
    const path = require.resolve('./background-loader.js')
    const worker = new Worker(path, { workerData: { dbPath: this.path } })
    worker.on('message', txid => {
      console.log('Loaded', txid, 'for execution')
      this._checkExecutability(txid)
    })
  }

  _checkExecutability (txid) {
    const row = this.isReadyToExecuteStmt.get(txid)
    if (row && row.ready && this.onReadyToExecute) this.onReadyToExecute(txid)
  }
}

// ------------------------------------------------------------------------------------------------

Database.HEIGHT_MEMPOOL = HEIGHT_MEMPOOL
Database.HEIGHT_UNKNOWN = HEIGHT_UNKNOWN

module.exports = Database
