"use strict";

function hasDesign(manifest) {
  return (
    manifest &&
    manifest.design &&
    typeof manifest.design === "object" &&
    !Array.isArray(manifest.design) &&
    Object.keys(manifest.design).length > 0
  );
}

function mergeArchitectureDesign(options, manifest) {
  if (!hasDesign(manifest)) {
    return options || {};
  }

  const mergedOptions = options ? { ...options } : {};
  if (mergedOptions.architectureDesign === undefined) {
    mergedOptions.architectureDesign = manifest.design;
  }
  return mergedOptions;
}

module.exports = {
  hasDesign,
  mergeArchitectureDesign,
};
