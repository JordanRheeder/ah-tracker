// Safe reader for WoW SavedVariables files: parses Lua table literals as data, never executes them.

export type LuaValue = string | number | boolean | null | LuaTable;
export interface LuaTable {
  /** Array part (implicit 1..n keys), in order. */
  list: LuaValue[];
  /** Explicit keys. Numeric keys are stored as strings. */
  map: Map<string, LuaValue>;
}

class Parser {
  i = 0;
  private readonly s: string;
  constructor(s: string) {
    this.s = s;
  }

  fail(msg: string): never {
    const line = this.s.slice(0, this.i).split("\n").length;
    throw new Error(`SavedVariables parse error on line ${line}: ${msg}`);
  }

  skip() {
    for (;;) {
      const c = this.s[this.i];
      if (c === " " || c === "\t" || c === "\r" || c === "\n") this.i++;
      else if (c === "-" && this.s[this.i + 1] === "-") {
        if (this.s.startsWith("--[[", this.i)) {
          const end = this.s.indexOf("]]", this.i + 4);
          this.i = end < 0 ? this.s.length : end + 2;
        } else {
          const end = this.s.indexOf("\n", this.i);
          this.i = end < 0 ? this.s.length : end + 1;
        }
      } else return;
    }
  }

  ident(): string {
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.s.slice(this.i, this.i + 256));
    if (!m) this.fail("expected a name");
    this.i += m[0].length;
    return m[0];
  }

  string(): string {
    const q = this.s[this.i++];
    let out = "";
    for (;;) {
      const c = this.s[this.i++];
      if (c === undefined) this.fail("unterminated string");
      if (c === q) return out;
      if (c !== "\\") { out += c; continue; }
      const e = this.s[this.i++];
      if (e === "n") out += "\n";
      else if (e === "t") out += "\t";
      else if (e === "r") out += "\r";
      else if (e === "\n") out += "\n";
      else if (e !== undefined && /[0-9]/.test(e)) {
        let digits = e;
        while (digits.length < 3 && /[0-9]/.test(this.s[this.i] ?? "")) digits += this.s[this.i++];
        out += String.fromCharCode(Number(digits));
      } else out += e ?? "";
    }
  }

  number(): number {
    const m = /^-?(0x[0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?|inf|nan)/.exec(this.s.slice(this.i, this.i + 64));
    if (!m) this.fail("expected a number");
    this.i += m[0].length;
    return Number(m[0]);
  }

  value(): LuaValue {
    this.skip();
    const c = this.s[this.i];
    if (c === "{") return this.table();
    if (c === '"' || c === "'") return this.string();
    if (c === "-" || c === "." || (c !== undefined && /[0-9]/.test(c))) return this.number();
    const word = this.ident();
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "nil") return null;
    return this.fail(`unexpected "${word}"`);
  }

  table(): LuaTable {
    this.i++; // {
    const t: LuaTable = { list: [], map: new Map() };
    for (;;) {
      this.skip();
      if (this.s[this.i] === "}") { this.i++; return t; }
      if (this.s[this.i] === "[") {
        this.i++;
        const key = this.value();
        this.skip();
        if (this.s[this.i++] !== "]") this.fail("expected ]");
        this.skip();
        if (this.s[this.i++] !== "=") this.fail("expected =");
        t.map.set(String(key), this.value());
      } else {
        const start = this.i;
        if (/[A-Za-z_]/.test(this.s[this.i] ?? "")) {
          const name = this.ident();
          this.skip();
          if (this.s[this.i] === "=") { this.i++; t.map.set(name, this.value()); }
          else { this.i = start; t.list.push(this.value()); }
        } else t.list.push(this.value());
      }
      this.skip();
      const sep = this.s[this.i];
      if (sep === "," || sep === ";") this.i++;
      else if (sep !== "}") this.fail("expected , or }");
    }
  }

  file(): Map<string, LuaValue> {
    const vars = new Map<string, LuaValue>();
    for (;;) {
      this.skip();
      if (this.i >= this.s.length) return vars;
      const name = this.ident();
      this.skip();
      if (this.s[this.i++] !== "=") this.fail("expected = after a variable name");
      vars.set(name, this.value());
    }
  }
}

/** Parses a SavedVariables file into its top-level variables. */
export function parseSavedVariables(text: string): Map<string, LuaValue> {
  return new Parser(text).file();
}

export function isTable(v: LuaValue | undefined): v is LuaTable {
  return typeof v === "object" && v !== null;
}
