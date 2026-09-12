#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sha256Directory, REQUIRED_FIELDS } = require('./prisma-runtime-probe.cjs');

function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function arg(name, fallback) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; }
const generatedDir = path.resolve(arg('--generated-dir', '.prisma/client'));
const schema = path.resolve(arg('--schema', 'src/prisma/schema.prisma'));
const output = path.resolve(arg('--output', 'prisma-client-manifest.json'));
const deploySha = arg('--deploy-sha', process.env.DEPLOY_SHA || 'unknown');
if (!fs.existsSync(generatedDir)) throw new Error('generated client directory missing: ' + generatedDir);
if (!fs.existsSync(schema)) throw new Error('Prisma schema missing: ' + schema);
const pkg = JSON.parse(fs.readFileSync(path.resolve(arg('--package', 'package.json')), 'utf8'));
const manifest = {
  format: 1,
  deploySha,
  clientVersion: pkg.dependencies?.['@prisma/client'] || pkg.devDependencies?.['@prisma/client'] || 'unknown',
  schemaHash: sha256(schema),
  generatedClientHash: sha256Directory(generatedDir),
  requiredFields: REQUIRED_FIELDS,
};
fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write(JSON.stringify(manifest) + '\n');
