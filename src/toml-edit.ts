/** Conservative TOML editor lexer. Values are preserved verbatim, never reserialized wholesale. */
export function decodeTomlKey(text: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < text.length) {
    while (/\s/.test(text[i] ?? "") && i < text.length) i++;
    let key = "";
    const quote = text[i];
    if (quote === '"' || quote === "'") {
      i++; let closed = false;
      while (i < text.length) {
        const c = text[i++]!;
        if (c === quote) { closed = true; break; }
        if (c === "\\" && quote === '"') {
          const escape = text[i++]!;
          if (escape === "u" || escape === "U") {
            const count = escape === "u" ? 4 : 8, hex = text.slice(i, i + count);
            if (!new RegExp(`^[0-9a-fA-F]{${count}}$`).test(hex)) throw new Error("unsupported TOML key escape");
            const point = parseInt(hex, 16);
            if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) throw new Error("invalid TOML Unicode key");
            key += String.fromCodePoint(point); i += count;
          } else {
            const escapes: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
            if (!(escape in escapes)) throw new Error("unsupported TOML key escape");
            key += escapes[escape];
          }
        } else key += c;
      }
      if (!closed) throw new Error("unterminated TOML key");
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
      if (!bare) throw new Error("unsupported TOML key");
      key = bare[0]; i += key.length;
    }
    keys.push(key);
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (i === text.length) break;
    if (text[i++] !== "." || i === text.length) throw new Error("unsupported TOML dotted key");
  }
  if (!keys.length) throw new Error("empty TOML key");
  return keys;
}

function unquoted(text: string, wanted: string): number {
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) { if (c === "\\" && quote === '"') i++; else if (c === quote) quote = ""; }
    else if (c === '"' || c === "'") quote = c;
    else if (wanted.includes(c)) return i;
  }
  return -1;
}
export function tomlHeader(line: string): { keys: string[]; array: boolean } | undefined {
  const comment = unquoted(line, "#");
  const text = (comment < 0 ? line : line.slice(0, comment)).trim();
  if (!text.startsWith("[")) return undefined;
  const array = text.startsWith("[["), width = array ? 2 : 1;
  if (!text.endsWith(array ? "]]" : "]")) throw new Error("unsupported TOML table header");
  return { keys: decodeTomlKey(text.slice(width, -width)), array };
}

export interface TomlStatement { start: number; end: number; table: string[]; header?: { keys: string[]; array: boolean }; key?: string[]; value?: string }
export function tomlStatements(content: string): TomlStatement[] {
  if (content.includes('"""') || content.includes("'''")) throw new Error("multiline TOML string requires manual configuration; no changes made");
  const lines = content.split(/\r?\n/), result: TomlStatement[] = [];
  let table: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.trim();
    if (!text || text.startsWith("#")) continue;
    const header = tomlHeader(text);
    if (header) { table = header.keys; result.push({ start: i, end: i + 1, table, header }); continue; }
    const eq = unquoted(text, "=");
    if (eq < 0) throw new Error("unsupported TOML assignment");
    const key = decodeTomlKey(text.slice(0, eq)), start = i;
    let value = text.slice(eq + 1).trim(), depth = 0, quote = "";
    for (let j = 0; ; j++) {
      if (j >= value.length) {
        if (quote) throw new Error("unterminated TOML value");
        if (depth === 0) break;
        if (++i >= lines.length) throw new Error("unterminated TOML array/value");
        value += "\n" + lines[i]; continue;
      }
      const c = value[j]!;
      if (quote) { if (c === "\\" && quote === '"') j++; else if (c === quote) quote = ""; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === "#") { const nl = value.indexOf("\n", j); j = nl < 0 ? value.length - 1 : nl; }
      else if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") { if (--depth < 0) throw new Error("unbalanced TOML value"); }
    }
    result.push({ start, end: i + 1, table, key, value });
  }
  return result;
}

export function assertEditableServers(content: string, names: readonly string[]): TomlStatement[] {
  const statements = tomlStatements(content), headers = new Set<string>();
  for (const s of statements) {
    const owned = s.table[0] === "mcp_servers" && names.includes(s.table[1] ?? "");
    if (s.header && owned) {
      if (s.header.array) throw new Error("array-table MCP configuration requires manual conversion");
      const key = JSON.stringify(s.table);
      if (headers.has(key)) throw new Error("duplicate MCP table (including quoted aliases); configuration was not changed");
      headers.add(key);
    }
    if (!s.key) continue;
    const absolute = [...s.table, ...s.key];
    if (absolute[0] === "mcp_servers" && (absolute.length === 1 || (!owned && names.includes(absolute[1] ?? "")))) {
      throw new Error("inline/dotted MCP configuration requires conversion to table form; configuration was not changed");
    }
  }
  return statements;
}

export function parseInlineStringTable(value: string): Map<string, string> {
  const comment = unquoted(value, "#");
  const text = (comment < 0 ? value : value.slice(0, comment)).trim();
  if (!text.startsWith("{") || !text.endsWith("}")) throw new Error("unsupported TOML environment syntax");
  const result = new Map<string, string>();
  let body = text.slice(1, -1).trim();
  while (body) {
    const comma = unquoted(body, ","), part = comma < 0 ? body : body.slice(0, comma);
    const eq = unquoted(part, "=");
    if (eq < 0) throw new Error("unsupported TOML environment syntax");
    const keys = decodeTomlKey(part.slice(0, eq)), literal = part.slice(eq + 1).trim();
    if (keys.length !== 1 || !/^("(?:\\.|[^"\\])*"|'[^']*')$/.test(literal)) throw new Error("unsupported TOML environment syntax");
    if (result.has(keys[0]!)) throw new Error("duplicate environment key");
    result.set(keys[0]!, literal);
    body = comma < 0 ? "" : body.slice(comma + 1).trim();
  }
  return result;
}
