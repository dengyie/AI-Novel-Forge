#!/usr/bin/env node
const path = require('node:path');
const { createRequire } = require('node:module');
const serverRequire = createRequire(path.resolve(__dirname, '../../server/package.json'));
serverRequire('dotenv/config');
const { prisma } = serverRequire('./dist/db/prisma.js');
const mode = process.argv[2] || '--post-migration';

async function main() {
  if (mode !== '--preflight' && mode !== '--post-migration') throw new Error('Use --preflight or --post-migration.');
  const active = await prisma.m4bEncodingJob.count({ where: { status: { in: ['pending', 'processing'] } } });
  if (mode === '--preflight') {
    console.log(JSON.stringify({ mode, activeJobs: active, requiresDrain: active > 0 }));
    if (active > 0) throw new Error('Drain active M4B jobs before ownership migration; it marks legacy pending/processing jobs failed.');
    return;
  }
  // SELECT references every ownership column even when the database contains no jobs.
  await prisma.m4bEncodingJob.findFirst({ select: { generationToken: true, leaseToken: true, lastProgressAt: true } });
  const unowned = await prisma.m4bEncodingJob.count({ where: {
    status: { in: ['pending', 'processing'] },
    OR: [{ generationToken: null }, { generationToken: '' },
      { status: 'processing', leaseToken: null }, { status: 'processing', lastProgressAt: null }],
  } });
  console.log(JSON.stringify({ mode, ownershipColumnsVerified: true, activeJobs: active, unownedActiveJobs: unowned }));
  if (unowned) throw new Error('Unowned active M4b jobs remain; do not start the worker until migration/drain is complete.');
}
main().catch(error => {
  console.error(`M4B database validation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
