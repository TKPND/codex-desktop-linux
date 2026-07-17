"use strict";

class CodexMicroPatchDriftError extends Error {
  constructor(message) {
    super(message);
    this.name = "CodexMicroPatchDriftError";
  }
}

function drift(message) {
  throw new CodexMicroPatchDriftError(message);
}

function isIdentifierStart(character) {
  return character != null && /[A-Za-z_$]/u.test(character);
}

function isIdentifierPart(character) {
  return character != null && /[A-Za-z0-9_$]/u.test(character);
}

function decodeEscape(source, index) {
  const character = source[index];
  const simple = {
    "0": "\0",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
  };
  if (Object.hasOwn(simple, character)) {
    return { value: simple[character], next: index + 1 };
  }
  if (character === "\n") return { value: "", next: index + 1 };
  if (character === "\r") {
    return { value: "", next: source[index + 1] === "\n" ? index + 2 : index + 1 };
  }
  if (character === "x") {
    const digits = source.slice(index + 1, index + 3);
    if (!/^[0-9A-Fa-f]{2}$/u.test(digits)) drift("invalid hexadecimal string escape");
    return { value: String.fromCodePoint(Number.parseInt(digits, 16)), next: index + 3 };
  }
  if (character === "u") {
    if (source[index + 1] === "{") {
      const close = source.indexOf("}", index + 2);
      const digits = close === -1 ? "" : source.slice(index + 2, close);
      if (!/^[0-9A-Fa-f]{1,6}$/u.test(digits)) drift("invalid Unicode string escape");
      const codePoint = Number.parseInt(digits, 16);
      if (codePoint > 0x10ffff) drift("invalid Unicode string escape");
      return { value: String.fromCodePoint(codePoint), next: close + 1 };
    }
    const digits = source.slice(index + 1, index + 5);
    if (!/^[0-9A-Fa-f]{4}$/u.test(digits)) drift("invalid Unicode string escape");
    return { value: String.fromCodePoint(Number.parseInt(digits, 16)), next: index + 5 };
  }
  if (character == null) drift("unterminated string escape");
  return { value: character, next: index + 1 };
}

function readString(source, start) {
  const quote = source[start];
  let index = start + 1;
  let value = "";
  let hasTemplateSubstitution = false;
  let templateExpressionDepth = 0;

  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      const decoded = decodeEscape(source, index + 1);
      value += decoded.value;
      index = decoded.next;
      continue;
    }
    if (quote === "`" && character === "$" && source[index + 1] === "{") {
      hasTemplateSubstitution = true;
      templateExpressionDepth += 1;
      value += "${";
      index += 2;
      continue;
    }
    if (quote === "`" && templateExpressionDepth > 0) {
      if (character === "{") templateExpressionDepth += 1;
      if (character === "}") templateExpressionDepth -= 1;
      if (character === "`" || character === "'" || character === '"') {
        drift("unsupported nested template expression");
      }
      value += character;
      index += 1;
      continue;
    }
    if (character === quote) {
      return {
        token: {
          type: "string",
          value,
          start,
          end: index + 1,
          quote,
          hasTemplateSubstitution,
        },
        next: index + 1,
      };
    }
    if (quote !== "`" && (character === "\n" || character === "\r")) {
      drift("unterminated string literal");
    }
    value += character;
    index += 1;
  }

  drift(quote === "`" ? "unterminated template literal" : "unterminated string literal");
}

function tokenizeJavaScript(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      const newline = source.indexOf("\n", index + 2);
      index = newline === -1 ? source.length : newline + 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      if (close === -1) drift("unterminated block comment");
      index = close + 2;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      const string = readString(source, index);
      tokens.push(string.token);
      index = string.next;
      continue;
    }
    if (isIdentifierStart(character)) {
      let end = index + 1;
      while (isIdentifierPart(source[end])) end += 1;
      tokens.push({
        type: "identifier",
        value: source.slice(index, end),
        start: index,
        end,
        quote: null,
        hasTemplateSubstitution: false,
      });
      index = end;
      continue;
    }
    tokens.push({
      type: "punctuation",
      value: character,
      start: index,
      end: index + 1,
      quote: null,
      hasTemplateSubstitution: false,
    });
    index += 1;
  }
  return tokens;
}

const DELIMITER_PAIRS = new Map([["(", ")"], ["{", "}"], ["[", "]"]]);
const CLOSING_DELIMITERS = new Set(DELIMITER_PAIRS.values());

function findMatchingDelimiter(tokens, openIndex) {
  const opening = tokens[openIndex]?.value;
  if (!DELIMITER_PAIRS.has(opening)) drift("delimiter search did not start at an opener");
  const stack = [];
  for (let index = openIndex; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (DELIMITER_PAIRS.has(value)) {
      stack.push(DELIMITER_PAIRS.get(value));
      continue;
    }
    if (!CLOSING_DELIMITERS.has(value)) continue;
    if (stack.at(-1) !== value) drift("mismatched JavaScript delimiters");
    stack.pop();
    if (stack.length === 0) return index;
  }
  drift("unbalanced JavaScript delimiters");
}

function classRanges(tokens) {
  const ranges = [];
  for (let classIndex = 0; classIndex < tokens.length; classIndex += 1) {
    if (tokens[classIndex].type !== "identifier" || tokens[classIndex].value !== "class") continue;
    let openIndex = classIndex + 1;
    while (openIndex < tokens.length && tokens[openIndex].value !== "{") openIndex += 1;
    if (openIndex === tokens.length) drift("class body is missing");
    const closeIndex = findMatchingDelimiter(tokens, openIndex);
    ranges.push({ openIndex, closeIndex });
  }
  return ranges;
}

function classMethods(tokens, classRange) {
  const methods = [];
  let index = classRange.openIndex + 1;
  while (index < classRange.closeIndex) {
    const token = tokens[index];
    if (DELIMITER_PAIRS.has(token.value)) {
      index = findMatchingDelimiter(tokens, index) + 1;
      continue;
    }
    if (
      token.type === "identifier" &&
      tokens[index + 1]?.value === "("
    ) {
      const parametersCloseIndex = findMatchingDelimiter(tokens, index + 1);
      const bodyOpenIndex = parametersCloseIndex + 1;
      if (tokens[bodyOpenIndex]?.value === "{") {
        const bodyCloseIndex = findMatchingDelimiter(tokens, bodyOpenIndex);
        if (bodyCloseIndex > classRange.closeIndex) drift("class method exceeds class body");
        methods.push({
          name: token.value,
          bodyOpenIndex,
          bodyCloseIndex,
        });
        index = bodyCloseIndex + 1;
        continue;
      }
    }
    index += 1;
  }
  return methods;
}

module.exports = {
  CodexMicroPatchDriftError,
  classMethods,
  classRanges,
  findMatchingDelimiter,
  tokenizeJavaScript,
};
