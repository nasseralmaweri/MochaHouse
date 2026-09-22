// Milestone 9E — a small, framework-free CSV serializer for HQ report
// exports. Deliberately NOT a generic reporting engine: no column DSL, no
// injectable service, no schema system — just the handful of pure
// functions every report's CSV mapper needs, and nothing more.

const FORMULA_TRIGGER_CHARS = new Set(['=', '+', '-', '@']);
const UTF8_BOM = '﻿';

// Text cell: safe for any string, including HQ-entered free text (e.g. a
// Location name) that could otherwise be interpreted as a spreadsheet
// formula. Two independent protections are applied, in order:
//
//   1. Formula-injection mitigation — spreadsheet software (Excel, Google
//      Sheets) treats a cell as a potential formula/command when its
//      FIRST NON-WHITESPACE character is one of = + - @ (leading
//      whitespace does not defeat this — "   =SUM(...)" is just as
//      dangerous as "=SUM(...)"). When detected, a single apostrophe is
//      prepended to the ORIGINAL, UNMODIFIED string — this is the
//      standard "force text" prefix spreadsheet software already
//      understands; nothing is stripped, trimmed or otherwise mutated.
//   2. RFC 4180 quoting — a cell containing a comma, double quote, or
//      CR/LF is wrapped in double quotes, with any embedded double quote
//      doubled.
//
// Never used for values the code itself knows are pure numbers (counts,
// decimal money, percentages) — see numericCsvCell below.
export function escapeCsvCell(raw: string): string {
  const firstNonWhitespaceIndex = raw.search(/\S/);
  const firstMeaningfulChar =
    firstNonWhitespaceIndex === -1 ? '' : raw[firstNonWhitespaceIndex];
  const protectedValue = FORMULA_TRIGGER_CHARS.has(firstMeaningfulChar)
    ? `'${raw}`
    : raw;
  return quoteIfNeeded(protectedValue);
}

// Numeric cell: for a value the code itself computed as a number (a
// count, a percentage) or a pre-formatted fixed-decimal numeric string
// (e.g. money already rendered to exactly two decimal places) — never
// free text, so formula-injection detection is deliberately skipped. A
// genuine negative number (e.g. -5) must render as the number -5, not be
// defensively mangled into text the way a suspicious string would be. A
// string input is passed through as-is (never round-tripped through
// Number(), which would silently drop a trailing ".50" -> ".5"); a plain
// number/numeric string never contains a comma, quote or newline either,
// so quoting is a no-op here in practice, applied only for uniformity
// with escapeCsvCell.
export function numericCsvCell(value: number | string): string {
  return quoteIfNeeded(String(value));
}

function quoteIfNeeded(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// Joins already-escaped rows (each cell already run through
// escapeCsvCell/numericCsvCell) into one CSV document: comma-separated
// cells, CRLF row endings, a trailing UTF-8 BOM at the very start for
// reliable Excel handling of non-ASCII text (accented characters, Arabic,
// etc. in a Location name).
export function buildCsvDocument(rows: string[][]): Buffer {
  const body = rows.map((row) => row.join(',')).join('\r\n');
  return Buffer.from(`${UTF8_BOM}${body}\r\n`, 'utf8');
}
