const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const Database = createRequire(require.resolve('@prisma/adapter-better-sqlite3'))('better-sqlite3');

test('migration inspection checks actual columns and rejects unowned or active legacy jobs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm4b-migration-inspection-'));
  const dbFile = path.join(dir, 'fixture.db');
  const db = new Database(dbFile);
  const run = mode => spawnSync(process.execPath, [path.resolve(__dirname, '../../scripts/deploy/inspect-m4b-worker-migration.cjs'), mode], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, AI_NOVEL_DATABASE_MODE: 'sqlite', DATABASE_URL: `file:${dbFile}` },
  });
  try {
    db.exec('CREATE TABLE M4bEncodingJob (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
    assert.equal(run('--preflight').status, 0);
    assert.equal(run('--post-migration').status, 1, 'empty legacy table must not pass the ownership column probe');
    db.exec('ALTER TABLE M4bEncodingJob ADD COLUMN generationToken TEXT; ALTER TABLE M4bEncodingJob ADD COLUMN leaseToken TEXT; ALTER TABLE M4bEncodingJob ADD COLUMN lastProgressAt DATETIME;');
    const valid = run('--post-migration');
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /"ownershipColumnsVerified":true/);
    db.exec("INSERT INTO M4bEncodingJob (id,status) VALUES ('old','pending')");
    assert.equal(run('--preflight').status, 1);
    assert.equal(run('--post-migration').status, 1);
    db.exec("UPDATE M4bEncodingJob SET status='failed'");
    assert.equal(run('--post-migration').status, 0);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
