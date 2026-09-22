import { buildCsvDocument, escapeCsvCell, numericCsvCell } from './csv-serializer';

// Milestone 9E — the CSV serializer, isolated from any report/database
// concern. escapeCsvCell is the text-cell path (formula-injection
// protection + RFC 4180 quoting); numericCsvCell is the numeric-cell path
// (RFC 4180 quoting only — no formula-injection detection, since a
// code-computed number is never attacker-controlled text).
describe('escapeCsvCell (Milestone 9E)', () => {
  it('1. leaves a simple cell unchanged', () => {
    expect(escapeCsvCell('Ann Arbor')).toBe('Ann Arbor');
  });

  it('2. quotes a cell containing a comma', () => {
    expect(escapeCsvCell('Dearborn, Heights')).toBe('"Dearborn, Heights"');
  });

  it('3. quotes and doubles embedded double quotes', () => {
    expect(escapeCsvCell('Mocha "House"')).toBe('"Mocha ""House"""');
  });

  it('4. quotes a cell containing a carriage return', () => {
    expect(escapeCsvCell('line1\rline2')).toBe('"line1\rline2"');
  });

  it('5. quotes a cell containing a line feed', () => {
    expect(escapeCsvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('6. quotes a cell containing CRLF', () => {
    expect(escapeCsvCell('line1\r\nline2')).toBe('"line1\r\nline2"');
  });

  it('7. handles an empty cell', () => {
    expect(escapeCsvCell('')).toBe('');
  });

  it('8. leaves Unicode / Arabic text unchanged (no escaping needed)', () => {
    expect(escapeCsvCell('مقهى موكا هاوس')).toBe('مقهى موكا هاوس');
    expect(escapeCsvCell('Café Déjà Vu')).toBe('Café Déjà Vu');
  });

  it('10. protects a cell starting with =', () => {
    expect(escapeCsvCell('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)");
  });

  it('11. protects a cell starting with +', () => {
    expect(escapeCsvCell('+1+1')).toBe("'+1+1");
  });

  it('12. protects a cell starting with -', () => {
    expect(escapeCsvCell('-2+3+cmd|/c calc')).toBe("'-2+3+cmd|/c calc");
  });

  it('13. protects a cell starting with @', () => {
    expect(escapeCsvCell('@SUM(A1:A2)')).toBe("'@SUM(A1:A2)");
  });

  it('14. protects a cell whose formula marker is preceded by leading whitespace, without stripping it', () => {
    expect(escapeCsvCell('   =SUM(A1:A2)')).toBe("'   =SUM(A1:A2)");
    expect(escapeCsvCell('\t-2+3')).toBe("'\t-2+3");
  });

  it('15. leaves ordinary safe text unchanged', () => {
    expect(escapeCsvCell('Mocha House - Ann Arbor')).toBe(
      'Mocha House - Ann Arbor',
    );
    expect(escapeCsvCell('Live platform data')).toBe('Live platform data');
  });

  it('combines formula protection and comma quoting correctly', () => {
    expect(escapeCsvCell('=A1,B1')).toBe('"\'=A1,B1"');
  });

  it('a fully whitespace cell has no meaningful first character and is not protected', () => {
    expect(escapeCsvCell('   ')).toBe('   ');
  });
});

describe('numericCsvCell (Milestone 9E)', () => {
  it('renders a plain count unchanged', () => {
    expect(numericCsvCell(42)).toBe('42');
  });

  it('renders zero unchanged', () => {
    expect(numericCsvCell(0)).toBe('0');
  });

  it('does NOT apply formula-injection protection to a genuine negative number', () => {
    // A number can never carry a formula payload — this is the "numeric-
    // safe cell" path, deliberately distinct from escapeCsvCell.
    expect(numericCsvCell(-5)).toBe('-5');
  });

  it('passes a pre-formatted fixed-decimal money string through without a round-trip through Number()', () => {
    // Number("1234.50") -> 1234.5 -> String() would silently drop the
    // trailing zero; numericCsvCell must never do that.
    expect(numericCsvCell('1234.50')).toBe('1234.50');
    expect(numericCsvCell('0.00')).toBe('0.00');
  });

  it('for contrast: the same negative-looking text WOULD be protected via escapeCsvCell', () => {
    expect(escapeCsvCell('-5')).toBe("'-5");
  });
});

describe('buildCsvDocument (Milestone 9E)', () => {
  it('9. begins with the UTF-8 BOM bytes (EF BB BF)', () => {
    const buffer = buildCsvDocument([['a', 'b']]);
    expect(buffer[0]).toBe(0xef);
    expect(buffer[1]).toBe(0xbb);
    expect(buffer[2]).toBe(0xbf);
  });

  it('joins cells with commas and rows with CRLF', () => {
    const buffer = buildCsvDocument([
      ['Metric', 'Value'],
      ['Total Orders', '42'],
    ]);
    const text = buffer.toString('utf8').replace(/^﻿/, '');
    expect(text).toBe('Metric,Value\r\nTotal Orders,42\r\n');
  });

  it('renders a blank row as an empty line', () => {
    const buffer = buildCsvDocument([['a'], [], ['b']]);
    const text = buffer.toString('utf8').replace(/^﻿/, '');
    expect(text).toBe('a\r\n\r\nb\r\n');
  });
});
