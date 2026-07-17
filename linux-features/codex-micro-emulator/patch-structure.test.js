#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BOOTSTRAP_MARKER,
  CodexMicroPatchDriftError,
  SERVICE_MARKER,
  classMethods,
  classRanges,
  findMatchingDelimiter,
  patchCodexMicroSources,
  tokenizeJavaScript,
} = require("./patch-structure.js");

function currentMainSource(overrides = {}) {
  const request = overrides.request ?? '"./codex-micro-service-C0OetNTY.js"';
  const className = overrides.className ?? "eS";
  const parameter = overrides.parameter ?? "e";
  const callbacks = overrides.callbacks ?? [
    "onDeviceStateChanged:e=>this.windowManager.sendMessageToAllWindows({state:e})",
    "onHidEvent:e=>this.windowManager.sendMessageToAllWindows({event:e})",
    "onJoystickEvent:e=>this.windowManager.sendMessageToAllWindows({event:e})",
  ];
  return [
    "const untouchedBefore=42;",
    `class ${className}{service=null;servicePromise=null;constructor(${parameter}){this.windowManager=${parameter}}`,
    "async getState(){let e=await this.getService();return e.start(),e.getState()}",
    `getService(){return Promise.resolve().then(()=>require(${request})).then(({CodexMicroService:e})=>new e({${callbacks.join(",")}}))}}`,
    "const untouchedAfter=7;",
  ].join("");
}

function currentServiceSource(identifier = "x") {
  return [
    '"use strict";',
    'const kit=require("@worklouder/device-kit-oai");',
    `class ${identifier}{constructor(options){this.options=options;this.api=new kit.RPCApiOAI(options)}}`,
    `exports.CodexMicroService=${identifier};`,
    "\n//# sourceMappingURL=codex-micro-service.js.map",
  ].join("");
}

function assertBoundedDrift(input, forbidden = "untouchedBefore") {
  let error;
  try {
    patchCodexMicroSources(input);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof CodexMicroPatchDriftError);
  assert.doesNotMatch(error.message, /[\r\n]/u);
  assert.equal(error.message.includes(forbidden), false);
  return error;
}

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

test("pure patch wraps the public service export and bootstraps the containing manager", () => {
  const original = {
    mainSource: currentMainSource(),
    serviceSource: currentServiceSource("x"),
  };
  const patched = patchCodexMicroSources(original);
  assert.equal(patched.changed, true);
  assert.match(patched.serviceSource, /extends x/u);
  assert.match(
    patched.serviceSource,
    /super\(\{\.\.\.e,\.\.\.codexLinuxCodexMicroEmulatorOptions\(\)\}\)/u,
  );
  assert.match(patched.serviceSource, /new kit\.RPCApiOAI\(options\)/u);
  assert.equal(patched.mainSource.split(BOOTSTRAP_MARKER).length - 1, 1);
  assert.match(patched.mainSource, /void this\.getState\(\)\.catch/u);
  assert.equal(patched.mainSource.includes("const untouchedBefore=42;"), true);
  assert.equal(patched.mainSource.includes("const untouchedAfter=7;"), true);
  assert.deepEqual(patchCodexMicroSources(patched), {
    mainSource: patched.mainSource,
    serviceSource: patched.serviceSource,
    changed: false,
  });
});

for (const request of [
  "'./codex-micro-service-Q1.js'",
  '"./codex-micro-service-Q2.js"',
  "`./codex-micro-service-Q3.js`",
]) {
  test(`module request spelling ${request} is structural`, () => {
    const patched = patchCodexMicroSources({
      mainSource: currentMainSource({ request }),
      serviceSource: currentServiceSource("z9"),
    });
    assert.match(patched.serviceSource, /extends z9/u);
    assert.equal(patched.mainSource.includes(BOOTSTRAP_MARKER), true);
  });
}

test("whitespace identifiers and callback ordering are not anchors", () => {
  const source = currentMainSource({
    className: "a0",
    parameter: "windowManager",
    callbacks: [
      "onJoystickEvent:e=>e",
      "onDeviceStateChanged:e=>e",
      "onHidEvent:e=>e",
    ],
  }).replaceAll(";", "; \n");
  const patched = patchCodexMicroSources({
    mainSource: source,
    serviceSource: currentServiceSource("Service9"),
  });
  assert.equal(patched.mainSource.includes(BOOTSTRAP_MARKER), true);
  assert.match(patched.serviceSource, /extends Service9/u);
});

test("service helper is inserted before a source map trailer", () => {
  const patched = patchCodexMicroSources({
    mainSource: currentMainSource(),
    serviceSource: currentServiceSource(),
  });
  assert.ok(patched.serviceSource.indexOf(SERVICE_MARKER) < patched.serviceSource.indexOf("sourceMappingURL="));
});

test("pure patch rejects missing and duplicate public exports without mutating inputs", () => {
  const service = currentServiceSource();
  for (const serviceSource of [
    service.replace("exports.CodexMicroService=x;", "exports.Other=x;"),
    `${service}\nexports.CodexMicroService=x;`,
  ]) {
    const input = { mainSource: currentMainSource(), serviceSource };
    const originals = { ...input };
    assertBoundedDrift(input);
    assert.deepEqual(input, originals);
  }
});

test("pure patch rejects missing duplicate and ambiguous manager structure", () => {
  const main = currentMainSource();
  const duplicateConstructor = main.replace(
    "constructor(e){this.windowManager=e}",
    "constructor(e){this.windowManager=e}constructor(t){this.other=t}",
  );
  for (const mainSource of [
    main.replace('require("./codex-micro-service-C0OetNTY.js")', 'require("./other.js")'),
    `${main}${main}`,
    duplicateConstructor,
    main.replace(
      'require("./codex-micro-service-C0OetNTY.js")',
      "require(`./codex-micro-service-${hash}.js`)",
    ),
    main.replace("new e({", "new e([{"),
  ]) {
    const input = { mainSource, serviceSource: currentServiceSource() };
    const originals = { ...input };
    assertBoundedDrift(input);
    assert.deepEqual(input, originals);
  }
});

test("pure patch rejects partial markers", () => {
  for (const input of [
    {
      mainSource: `${currentMainSource()};console.error("${BOOTSTRAP_MARKER}")`,
      serviceSource: currentServiceSource(),
    },
    {
      mainSource: currentMainSource(),
      serviceSource: `${currentServiceSource()};${SERVICE_MARKER}{}`,
    },
  ]) {
    const originals = { ...input };
    assert.match(assertBoundedDrift(input).message, /partial/u);
    assert.deepEqual(input, originals);
  }
});
