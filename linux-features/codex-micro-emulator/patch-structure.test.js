#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  applyCodexMicroEmulatorExtractedApp,
} = require("./patch.js");

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

function writeExtractedFixture(root, overrides = {}) {
  const buildDir = path.join(root, ".vite", "build");
  fs.mkdirSync(buildDir, { recursive: true });
  const mainPath = path.join(buildDir, overrides.mainName ?? "main-hw0RxS4P.js");
  const servicePath = path.join(
    buildDir,
    overrides.serviceName ?? "codex-micro-service-C0OetNTY.js",
  );
  fs.writeFileSync(mainPath, overrides.mainSource ?? currentMainSource());
  fs.writeFileSync(servicePath, overrides.serviceSource ?? currentServiceSource());
  return { buildDir, mainPath, servicePath };
}

function withoutWarnings(callback) {
  const warnings = [];
  const previousWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    return { result: callback(), warnings };
  } finally {
    console.warn = previousWarn;
  }
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

test("scanner safely skips quoted and nested templates inside substitutions", () => {
  const source = [
    "const label=`prefix ${condition&&`nested ${value.replace(/'/g, \"quoted\")}`} suffix`;",
    'require("./codex-micro-service-C0OetNTY.js")',
  ].join("");
  const tokens = tokenizeJavaScript(source);
  const strings = tokens.filter(({ type }) => type === "string");
  assert.equal(strings[0].hasTemplateSubstitution, true);
  assert.equal(strings.at(-1).value, "./codex-micro-service-C0OetNTY.js");
  assert.equal(strings.at(-1).hasTemplateSubstitution, false);
});

test("scanner skips regular expressions that contain structural decoys", () => {
  const source = "/class Fake{}[\"']/g;class Manager{constructor(){this.ready=true}}";
  const tokens = tokenizeJavaScript(source);
  assert.equal(tokens.filter(({ type }) => type === "regex").length, 1);
  assert.equal(classRanges(tokens).length, 1);
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

test("delimiter matching ignores delimiter-shaped string values", () => {
  const tokens = tokenizeJavaScript(
    'class Manager{method(){return value.startsWith("{")||value.startsWith("[")}}',
  );
  const ranges = classRanges(tokens);
  assert.equal(ranges.length, 1);
  assert.deepEqual(classMethods(tokens, ranges[0]).map(({ name }) => name), ["method"]);
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

test("extracted-app patch writes both validated sources", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-patch-"));
  try {
    const paths = writeExtractedFixture(root);
    const result = applyCodexMicroEmulatorExtractedApp(root);
    assert.deepEqual(result, { matched: 2, changed: 2 });
    assert.equal(fs.readFileSync(paths.mainPath, "utf8").includes(BOOTSTRAP_MARKER), true);
    assert.match(
      fs.readFileSync(paths.servicePath, "utf8"),
      new RegExp(SERVICE_MARKER.replace(/[()]/gu, "\\$&")),
    );
    assert.deepEqual(applyCodexMicroEmulatorExtractedApp(root), { matched: 2, changed: 0 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("extracted-app discovery fails closed for missing and duplicate candidates", () => {
  const roots = [];
  try {
    const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-missing-"));
    roots.push(missingRoot);
    const missing = withoutWarnings(() => applyCodexMicroEmulatorExtractedApp(missingRoot));
    assert.deepEqual(missing.result, {
      matched: 0,
      changed: 0,
      reason: "Codex Micro build directory is missing",
    });

    const duplicateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-duplicate-"));
    roots.push(duplicateRoot);
    const paths = writeExtractedFixture(duplicateRoot);
    fs.copyFileSync(paths.mainPath, path.join(paths.buildDir, "main-duplicate.js"));
    const originals = [
      fs.readFileSync(paths.mainPath, "utf8"),
      fs.readFileSync(paths.servicePath, "utf8"),
    ];
    const duplicate = withoutWarnings(() => applyCodexMicroEmulatorExtractedApp(duplicateRoot));
    assert.equal(duplicate.result.matched, 0);
    assert.match(duplicate.result.reason, /main bundle candidates/u);
    assert.deepEqual([
      fs.readFileSync(paths.mainPath, "utf8"),
      fs.readFileSync(paths.servicePath, "utf8"),
    ], originals);
  } finally {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
});

test("extracted-app discovery requires Work Louder package and public export", () => {
  for (const serviceSource of [
    currentServiceSource().replace("@worklouder/device-kit-oai", "other-device-kit"),
    currentServiceSource().replace("exports.CodexMicroService=x;", "exports.Other=x;"),
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-service-candidate-"));
    try {
      const paths = writeExtractedFixture(root, { serviceSource });
      const originals = [
        fs.readFileSync(paths.mainPath, "utf8"),
        fs.readFileSync(paths.servicePath, "utf8"),
      ];
      const { result } = withoutWarnings(() => applyCodexMicroEmulatorExtractedApp(root));
      assert.equal(result.matched, 0);
      assert.match(result.reason, /service bundle candidates/u);
      assert.deepEqual([
        fs.readFileSync(paths.mainPath, "utf8"),
        fs.readFileSync(paths.servicePath, "utf8"),
      ], originals);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("extracted-app transformation and syntax drift never write either bundle", () => {
  const variants = [
    { mainSource: `${currentMainSource()}${currentMainSource()}` },
    { serviceSource: `${currentServiceSource()}\nexports.CodexMicroService=x;` },
    { mainSource: `${currentMainSource()};const =` },
    {
      mainSource: `${currentMainSource()};console.error("${BOOTSTRAP_MARKER}")`,
    },
  ];
  for (const [variantIndex, variant] of variants.entries()) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-drift-"));
    try {
      const paths = writeExtractedFixture(root, variant);
      const originals = {
        main: fs.readFileSync(paths.mainPath, "utf8"),
        service: fs.readFileSync(paths.servicePath, "utf8"),
      };
      const { result, warnings } = withoutWarnings(() => applyCodexMicroEmulatorExtractedApp(root));
      assert.equal(result.matched, 0, `variant ${variantIndex}: ${JSON.stringify(result)}`);
      assert.equal(result.changed, 0);
      assert.equal(warnings.length, 1);
      assert.doesNotMatch(result.reason, /[\r\n]/u);
      assert.equal(fs.readFileSync(paths.mainPath, "utf8"), originals.main);
      assert.equal(fs.readFileSync(paths.servicePath, "utf8"), originals.service);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("second bundle write failure restores both originals", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-rollback-"));
  try {
    const paths = writeExtractedFixture(root);
    const originals = {
      main: fs.readFileSync(paths.mainPath, "utf8"),
      service: fs.readFileSync(paths.servicePath, "utf8"),
    };
    let writes = 0;
    const fsImpl = {
      ...fs,
      writeFileSync(filePath, contents) {
        writes += 1;
        if (writes === 2) throw new Error("simulated second write failure");
        fs.writeFileSync(filePath, contents);
      },
    };
    const { result } = withoutWarnings(() =>
      applyCodexMicroEmulatorExtractedApp(root, { fsImpl })
    );
    assert.equal(result.matched, 0);
    assert.equal(result.changed, 0);
    assert.match(result.reason, /write failed/u);
    assert.equal(fs.readFileSync(paths.mainPath, "utf8"), originals.main);
    assert.equal(fs.readFileSync(paths.servicePath, "utf8"), originals.service);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rollback restoration failure is a bounded hard error", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-rollback-failure-"));
  try {
    writeExtractedFixture(root);
    let writes = 0;
    const fsImpl = {
      ...fs,
      writeFileSync(filePath, contents) {
        writes += 1;
        if (writes === 2) throw new Error("simulated forward failure");
        if (writes === 3) throw new Error("simulated restore failure");
        fs.writeFileSync(filePath, contents);
      },
    };
    assert.throws(
      () => withoutWarnings(() => applyCodexMicroEmulatorExtractedApp(root, { fsImpl })),
      (error) => {
        assert.match(error.message, /rollback failed/u);
        assert.doesNotMatch(error.message, /untouchedBefore|RPCApiOAI/u);
        assert.doesNotMatch(error.message, /[\r\n]/u);
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
