/**
 * The text in a file, as far as this service can read it.
 *
 * Text files are their own text. A PDF is read for the strings its content streams draw — enough for the documents
 * this fleet produces and for a search to find them by a phrase, and honestly not a PDF parser: a scanned page, a
 * compressed stream or a font with a custom encoding yields nothing, and the file is indexed by its name alone.
 * Anything else is indexed by its name.
 */
export function textOf(contentType: string, name: string, bytes: Uint8Array): string {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type.startsWith("text/") || type === "application/json" || /\.(md|txt|csv|json|log)$/i.test(name)) {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
  if (type === "application/pdf" || /\.pdf$/i.test(name)) return pdfText(bytes);
  return "";
}

/** Strings drawn by `Tj`, `'` and `TJ` operators in uncompressed content streams, in the order they appear. */
function pdfText(bytes: Uint8Array): string {
  const raw = new TextDecoder("latin1").decode(bytes);
  const out: string[] = [];
  // ( ... ) Tj  |  ( ... ) '  |  [ (..) (..) ] TJ
  const re = /\(((?:\\.|[^\\)])*)\)\s*(?:Tj|')|\[((?:[^\]\\]|\\.)*)\]\s*TJ/g;
  for (const m of raw.matchAll(re)) {
    if (m[1] !== undefined) out.push(unescape(m[1]));
    else if (m[2] !== undefined) out.push([...m[2].matchAll(/\(((?:\\.|[^\\)])*)\)/g)].map((s) => unescape(s[1] ?? "")).join(""));
  }
  return out.join("\n");
}

function unescape(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c: string) => {
    if (c === "n") return "\n";
    if (c === "r") return "\r";
    if (c === "t") return "\t";
    if (c === "b" || c === "f") return "";
    if (/^[0-7]+$/.test(c)) return String.fromCharCode(parseInt(c, 8));
    return c;
  });
}
