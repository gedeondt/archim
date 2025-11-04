"use strict";

const fs = require("fs");
const path = require("path");

const { DEFAULT_ARCHITECTURES_DIR } = require("./constants");
const { mergeArchitectureDesign } = require("./options");
const { launchPiece } = require("./pieces");

async function loadArchitectureDefinition(name) {
  if (!name) {
    throw new Error("Architecture name is required");
  }

  const manifestPath = path.resolve(DEFAULT_ARCHITECTURES_DIR, name, "manifest.json");
  let manifestRaw;
  try {
    manifestRaw = await fs.promises.readFile(manifestPath, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read manifest for architecture '${name}' at ${manifestPath}: ${error.message}`
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch (error) {
    throw new Error(`Invalid JSON in architecture '${name}' manifest: ${error.message}`);
  }

  if (!manifest || !Array.isArray(manifest.phases)) {
    throw new Error(`Architecture '${name}' must define a 'phases' array`);
  }

  return {
    name,
    manifest,
    manifestPath,
    manifestDir: path.dirname(manifestPath),
  };
}

function resolveManifestModule(manifestDir, modulePath) {
  if (path.isAbsolute(modulePath)) {
    return modulePath;
  }

  const manifestRelative = path.resolve(manifestDir, modulePath);
  if (fs.existsSync(manifestRelative)) {
    return manifestRelative;
  }

  return path.resolve(process.cwd(), modulePath);
}

async function launchArchitecture(definition, launchedPieces) {
  const { name, manifest, manifestDir } = definition;
  console.info(`[launcher] Launching architecture '${name}' (${definition.manifestPath})`);

  for (let index = 0; index < manifest.phases.length; index += 1) {
    const phase = manifest.phases[index] || {};
    const phaseName = phase.phase || `phase-${index + 1}`;
    console.info(`[launcher] Phase '${phaseName}' starting`);

    if (phase.script) {
      const scriptPath = resolveManifestModule(manifestDir, phase.script);
      // eslint-disable-next-line no-await-in-loop
      const metadata = await launchPiece({
        modulePath: scriptPath,
        port: phase.port,
        options: mergeArchitectureDesign(phase.options, manifest),
      });
      metadata.phase = phaseName;
      metadata.architecture = name;
      launchedPieces.push(metadata);
    }

    if (Array.isArray(phase.pieces)) {
      for (const piece of phase.pieces) {
        if (!piece || !piece.module) {
          throw new Error(
            `Phase '${phaseName}' in architecture '${name}' contains an invalid piece definition`
          );
        }
        const resolvedModulePath = resolveManifestModule(manifestDir, piece.module);
        // eslint-disable-next-line no-await-in-loop
        const metadata = await launchPiece({
          modulePath: resolvedModulePath,
          port: piece.port,
          options: mergeArchitectureDesign(piece.options, manifest),
        });
        metadata.phase = phaseName;
        metadata.architecture = name;
        launchedPieces.push(metadata);
      }
    }

    console.info(`[launcher] Phase '${phaseName}' completed`);
  }
}

module.exports = {
  launchArchitecture,
  loadArchitectureDefinition,
  resolveManifestModule,
};
