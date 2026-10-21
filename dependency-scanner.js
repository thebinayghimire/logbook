"use strict";

/**
 * Multi-Repository Dependency & Hygiene Radar Scanner.
 *
 * Scans project folders for package manifests and hygiene compliance.
 */

const fsp = require("fs").promises;
const path = require("path");

async function scanRepositoryHygieneAndDeps(repoPath) {
  const result = {
    path: repoPath,
    name: path.basename(repoPath),
    hasReadme: false,
    hasLicense: false,
    hasGitignore: false,
    hasWorkflow: false,
    manifests: [],
    dependenciesCount: 0
  };

  try {
    const entries = await fsp.readdir(repoPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (lower.startsWith("readme")) result.hasReadme = true;
      if (lower.startsWith("license") || lower.startsWith("licence")) result.hasLicense = true;
      if (lower === ".gitignore") result.hasGitignore = true;

      if (lower === "package.json") {
        result.manifests.push("package.json");
        try {
          const raw = await fsp.readFile(path.join(repoPath, entry.name), "utf8");
          const pkg = JSON.parse(raw);
          const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
          result.dependenciesCount += Object.keys(deps).length;
        } catch (e) {}
      } else if (lower === "cargo.toml") {
        result.manifests.push("Cargo.toml");
      } else if (lower === "requirements.txt" || lower === "pyproject.toml") {
        result.manifests.push(entry.name);
      } else if (lower === "go.mod") {
        result.manifests.push("go.mod");
      }
    }

    const githubDir = path.join(repoPath, ".github", "workflows");
    try {
      const stats = await fsp.stat(githubDir);
      if (stats.isDirectory()) result.hasWorkflow = true;
    } catch (e) {}
  } catch (e) {}

  return result;
}

module.exports = {
  scanRepositoryHygieneAndDeps
};
