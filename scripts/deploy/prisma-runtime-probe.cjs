#!/usr/bin/env node
/** Inspect Prisma's loaded runtime model without opening a database connection. */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const REQUIRED_FIELDS = [{ model: "AudiobookTask", field: "m4bGenerationToken" }];

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function sha256Directory(root) {
  const hash = crypto.createHash("sha256");
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(root);
  files.sort();
  for (const file of files) {
    hash.update(path.relative(root, file));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function inspectPrismaRuntime({ requireFrom, requiredFields = REQUIRED_FIELDS } = {}) {
  const base = requireFrom || process.cwd();
  const clientPath = require.resolve("@prisma/client", { paths: [base] });
  const clientModule = require(clientPath);
  // An adapter-shaped object satisfies Prisma's constructor validation. No
  // adapter method is invoked, so this probe cannot read or write the database.
  let client;
  let provider;
  let lastError;
  for (const candidate of ["sqlite", "postgres"]) {
    try {
      client = new clientModule.PrismaClient({ adapter: { provider: candidate, adapterName: "runtime-probe" } });
      provider = candidate;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!client) throw lastError || new Error("unable to construct Prisma client");
  const runtime = client._runtimeDataModel;
  const models = {};
  const missing = [];
  for (const [modelName, model] of Object.entries(runtime?.models || {})) {
    models[modelName] = { fields: {} };
    for (const field of model.fields || []) models[modelName].fields[field.name] = true;
  }
  for (const required of requiredFields) {
    if (!models[required.model]?.fields?.[required.field]) missing.push(required.model + "." + required.field);
  }
  const generatedRoot = path.dirname(path.dirname(path.dirname(clientPath)));
  const generatedClientDir = path.join(generatedRoot, ".prisma", "client");
  const report = {
    ok: missing.length === 0,
    provider,
    clientPath,
    generatedClientDir,
    generatedClientHash: fs.existsSync(generatedClientDir) ? sha256Directory(generatedClientDir) : "",
    models,
    missing,
  };
  if (!report.ok) throw new Error("missing required Prisma runtime fields: " + missing.join(", "));
  return report;
}

if (require.main === module) {
  try {
    const report = inspectPrismaRuntime({ requireFrom: process.cwd() });
    const manifestPath = process.env.PRISMA_RUNTIME_MANIFEST;
    if (manifestPath) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest.generatedClientHash !== report.generatedClientHash) {
        throw new Error("generated Prisma client hash does not match manifest");
      }
      report.manifest = manifestPath;
    }
    process.stdout.write(JSON.stringify(report) + "\n");
  } catch (error) {
    process.stderr.write("[prisma-runtime-probe] " + error.message + "\n");
    process.exitCode = 1;
  }
}

module.exports = { inspectPrismaRuntime, sha256File, sha256Directory, REQUIRED_FIELDS };
