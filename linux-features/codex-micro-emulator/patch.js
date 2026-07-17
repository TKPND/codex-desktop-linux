"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  CodexMicroPatchDriftError,
  patchCodexMicroSources,
  tokenizeJavaScript,
} = require("./patch-structure.js");

const PATCH_SKIP_WARNING =
  "WARN: Codex Micro emulator patch drifted - leaving main and service bundles unchanged";
const MAIN_NAME_PATTERN = /^main-[^/]+\.js$/u;
const SERVICE_NAME_PATTERN = /^codex-micro-service-[^/]+\.js$/u;
const SERVICE_REQUEST_PATTERN = /^\.\/codex-micro-service-[^/]+\.js$/u;

function boundedReason(error) {
  const message = error instanceof Error ? error.message : String(error);
  const oneLine = message.replace(/[\r\n\t]+/gu, " ").replace(/\s+/gu, " ").trim();
  return oneLine.slice(0, 240) || "unknown Codex Micro patch failure";
}

function countPublicServiceExports(tokens) {
  let count = 0;
  for (let index = 0; index <= tokens.length - 4; index += 1) {
    if (
      tokens[index].type === "identifier" &&
      tokens[index].value === "exports" &&
      tokens[index + 1].value === "." &&
      tokens[index + 2].type === "identifier" &&
      tokens[index + 2].value === "CodexMicroService" &&
      tokens[index + 3].value === "="
    ) {
      count += 1;
    }
  }
  return count;
}

function isMainCandidate(source) {
  const requests = tokenizeJavaScript(source).filter((token) =>
    token.type === "string" &&
    SERVICE_REQUEST_PATTERN.test(token.value) &&
    !token.hasTemplateSubstitution
  );
  return requests.length === 1;
}

function isServiceCandidate(source) {
  const tokens = tokenizeJavaScript(source);
  const packageRequests = tokens.filter((token) =>
    token.type === "string" &&
    token.value === "@worklouder/device-kit-oai" &&
    !token.hasTemplateSubstitution
  );
  return packageRequests.length === 1 && countPublicServiceExports(tokens) === 1;
}

function skip(reason) {
  console.warn(`${PATCH_SKIP_WARNING}: ${reason}`);
  return { matched: 0, changed: 0, reason };
}

function discoverCandidates(io, buildDir) {
  if (!io.existsSync(buildDir)) {
    throw new CodexMicroPatchDriftError("Codex Micro build directory is missing");
  }
  const names = io.readdirSync(buildDir);
  const mainCandidates = [];
  const serviceCandidates = [];
  for (const name of names) {
    if (!MAIN_NAME_PATTERN.test(name) && !SERVICE_NAME_PATTERN.test(name)) continue;
    const filePath = path.join(buildDir, name);
    const source = io.readFileSync(filePath, "utf8");
    if (MAIN_NAME_PATTERN.test(name) && isMainCandidate(source)) {
      mainCandidates.push({ path: filePath, source });
    }
    if (SERVICE_NAME_PATTERN.test(name) && isServiceCandidate(source)) {
      serviceCandidates.push({ path: filePath, source });
    }
  }
  if (mainCandidates.length !== 1) {
    throw new CodexMicroPatchDriftError(
      `expected one main bundle candidates match, found ${mainCandidates.length}`,
    );
  }
  if (serviceCandidates.length !== 1) {
    throw new CodexMicroPatchDriftError(
      `expected one service bundle candidates match, found ${serviceCandidates.length}`,
    );
  }
  return { main: mainCandidates[0], service: serviceCandidates[0] };
}

function restoreAttemptedWrites(io, attempted, originals) {
  const failures = [];
  for (const filePath of [...attempted].reverse()) {
    try {
      io.writeFileSync(filePath, originals.get(filePath));
    } catch (error) {
      failures.push(`${path.basename(filePath)}: ${boundedReason(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Codex Micro emulator rollback failed: ${failures.join("; ")}`);
  }
}

function applyCodexMicroEmulatorExtractedApp(extractedDir, options = {}) {
  const io = options.fsImpl ?? fs;
  const buildDir = path.join(extractedDir, ".vite", "build");
  let candidates;
  let patched;
  try {
    candidates = discoverCandidates(io, buildDir);
    patched = patchCodexMicroSources({
      mainSource: candidates.main.source,
      serviceSource: candidates.service.source,
    });
    new vm.Script(patched.serviceSource, {
      filename: path.basename(candidates.service.path),
    });
    new vm.Script(patched.mainSource, {
      filename: path.basename(candidates.main.path),
    });
  } catch (error) {
    return skip(boundedReason(error));
  }

  if (!patched.changed) return { matched: 2, changed: 0 };

  const originals = new Map([
    [candidates.service.path, candidates.service.source],
    [candidates.main.path, candidates.main.source],
  ]);
  const attempted = [];
  try {
    attempted.push(candidates.service.path);
    io.writeFileSync(candidates.service.path, patched.serviceSource);
    attempted.push(candidates.main.path);
    io.writeFileSync(candidates.main.path, patched.mainSource);
  } catch (error) {
    restoreAttemptedWrites(io, attempted, originals);
    return skip(`write failed: ${boundedReason(error)}`);
  }
  return { matched: 2, changed: 2 };
}

const descriptors = [{
  id: "codex-micro-emulator-extracted-app",
  phase: "extracted-app:pre-webview",
  order: 19_700,
  apply: applyCodexMicroEmulatorExtractedApp,
}];

module.exports = {
  PATCH_SKIP_WARNING,
  applyCodexMicroEmulatorExtractedApp,
  descriptors,
};
