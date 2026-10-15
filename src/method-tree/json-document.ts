/**
 * A strict JSON parser (RFC 8259) that keeps what `JSON.parse` loses and a receiver of a map of
 * file entries needs: an object's members as the pairs written, so a key given twice is seen, and
 * a number as its lexeme, so a `size` written `13.0` or `1.3e1` can be told from `13`. A string may
 * hold a lone surrogate written as an escape (`"\ud800"`), as JSON's grammar allows; the map rules
 * refuse it where it matters.
 */

export type JsonValue =
  | { readonly kind: "object"; readonly pairs: readonly (readonly [string, JsonValue])[] }
  | { readonly kind: "array"; readonly items: readonly JsonValue[] }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly lexeme: string }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "null" };

/** Text that is not one JSON value. */
export class JsonDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonDocumentError";
  }
}

/** Deeper nesting than any map of file entries needs is refused rather than risk the stack. */
const MAX_DEPTH = 512;
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const HEX4 = /^[0-9A-Fa-f]{4}$/;

class Parser {
  private index = 0;

  constructor(private readonly text: string) {}

  parseDocument(): JsonValue {
    // A byte order mark is no JSON whitespace, and Python's `json.loads` refuses it too.
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.text.length) this.fail("unexpected text after the JSON value");
    return value;
  }

  private fail(reason: string): never {
    throw new JsonDocumentError(`Invalid JSON at offset ${this.index}: ${reason}`);
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length) {
      const character = this.text[this.index];
      if (character === " " || character === "\t" || character === "\n" || character === "\r") {
        this.index += 1;
      } else {
        return;
      }
    }
  }

  private expectLiteral(literal: string): void {
    if (this.text.startsWith(literal, this.index)) {
      this.index += literal.length;
      return;
    }
    this.fail(`expected ${literal}`);
  }

  private parseValue(depth: number): JsonValue {
    if (depth > MAX_DEPTH) this.fail("nested too deeply");
    const character = this.text[this.index];
    switch (character) {
      case "{":
        return this.parseObject(depth);
      case "[":
        return this.parseArray(depth);
      case '"':
        return { kind: "string", value: this.parseString() };
      case "t":
        this.expectLiteral("true");
        return { kind: "boolean", value: true };
      case "f":
        this.expectLiteral("false");
        return { kind: "boolean", value: false };
      case "n":
        this.expectLiteral("null");
        return { kind: "null" };
      default: {
        NUMBER.lastIndex = this.index;
        const match = NUMBER.exec(this.text);
        if (match === null) this.fail("expected a JSON value");
        this.index += match[0].length;
        return { kind: "number", lexeme: match[0] };
      }
    }
  }

  private parseObject(depth: number): JsonValue {
    this.index += 1;
    const pairs: (readonly [string, JsonValue])[] = [];
    this.skipWhitespace();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return { kind: "object", pairs };
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.index] !== '"') this.fail("expected a string key");
      const key = this.parseString();
      this.skipWhitespace();
      if (this.text[this.index] !== ":") this.fail("expected ':'");
      this.index += 1;
      this.skipWhitespace();
      pairs.push([key, this.parseValue(depth + 1)]);
      this.skipWhitespace();
      const separator = this.text[this.index];
      this.index += 1;
      if (separator === "}") return { kind: "object", pairs };
      if (separator !== ",") this.fail("expected ',' or '}'");
    }
  }

  private parseArray(depth: number): JsonValue {
    this.index += 1;
    const items: JsonValue[] = [];
    this.skipWhitespace();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return { kind: "array", items };
    }
    for (;;) {
      this.skipWhitespace();
      items.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      const separator = this.text[this.index];
      this.index += 1;
      if (separator === "]") return { kind: "array", items };
      if (separator !== ",") this.fail("expected ',' or ']'");
    }
  }

  private parseString(): string {
    this.index += 1;
    let value = "";
    let runStart = this.index;
    for (;;) {
      if (this.index >= this.text.length) this.fail("unterminated string");
      const code = this.text.charCodeAt(this.index);
      if (code === 0x22) {
        value += this.text.slice(runStart, this.index);
        this.index += 1;
        return value;
      }
      if (code < 0x20) this.fail("a control character must be escaped in a string");
      if (code !== 0x5c) {
        this.index += 1;
        continue;
      }
      value += this.text.slice(runStart, this.index);
      const escape = this.text[this.index + 1];
      this.index += 2;
      switch (escape) {
        case '"':
          value += '"';
          break;
        case "\\":
          value += "\\";
          break;
        case "/":
          value += "/";
          break;
        case "b":
          value += "\b";
          break;
        case "f":
          value += "\f";
          break;
        case "n":
          value += "\n";
          break;
        case "r":
          value += "\r";
          break;
        case "t":
          value += "\t";
          break;
        case "u": {
          const hex = this.text.slice(this.index, this.index + 4);
          if (!HEX4.test(hex)) this.fail("expected four hexadecimal digits after \\u");
          value += String.fromCharCode(Number.parseInt(hex, 16));
          this.index += 4;
          break;
        }
        default:
          this.index -= 2;
          this.fail("invalid escape in a string");
      }
      runStart = this.index;
    }
  }
}

/** Parse JSON text strictly, keeping every object's pairs and every number's lexeme. */
export function parseJsonDocument(text: string): JsonValue {
  return new Parser(text).parseDocument();
}
