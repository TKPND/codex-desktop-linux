#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CodexMicroPatchDriftError,
  classMethods,
  classRanges,
  findMatchingDelimiter,
  tokenizeJavaScript,
} = require("./patch-structure.js");

test("scanner decodes service requests across supported quote spellings", () => {
  for (const literal of [
    "'./codex-micro-service-A1.js'",
    '"./codex-micro-service-B2.js"',
    "`./codex-micro-service-C3.js`",
  ]) {
    const tokens = tokenizeJavaScript(`require(${literal})`);
    const request = tokens.find((token) => token.type === "string");
    assert.equal(request.value.match(/^\.\/codex-micro-service-.*\.js$/) != null, true);
    assert.equal(request.hasTemplateSubstitution, false);
  }
});

test("scanner records template substitution instead of accepting it as a module request", () => {
  const request = tokenizeJavaScript("require(`./codex-micro-service-${hash}.js`)")
    .find((token) => token.type === "string");
  assert.equal(request.hasTemplateSubstitution, true);
});

test("scanner skips comments and returns balanced class method bodies", () => {
  const source = "/* class Fake{} */ class Manager{constructor(e){this.w=e}// }\ngetState(){return this.w}}";
  const tokens = tokenizeJavaScript(source);
  const ranges = classRanges(tokens);
  assert.equal(ranges.length, 1);
  assert.deepEqual(ranges.map(({ openIndex, closeIndex }) => [
    tokens[openIndex].value,
    tokens[closeIndex].value,
  ]), [["{", "}"]]);
  assert.deepEqual(classMethods(tokens, ranges[0]).map(({ name }) => name), [
    "constructor",
    "getState",
  ]);
  assert.equal(tokens[findMatchingDelimiter(tokens, ranges[0].openIndex)].value, "}");
});

test("scanner rejects mismatched delimiters", () => {
  const tokens = tokenizeJavaScript("class Manager{constructor(){]");
  const openIndex = tokens.findIndex((token) => token.value === "{");
  assert.throws(
    () => findMatchingDelimiter(tokens, openIndex),
    CodexMicroPatchDriftError,
  );
});

test("scanner rejects unterminated comments strings and templates", () => {
  for (const source of ["/* no end", "'no end", '"no end', "`no end"]) {
    assert.throws(() => tokenizeJavaScript(source), CodexMicroPatchDriftError);
  }
});
