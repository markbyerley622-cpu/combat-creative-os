/**
 * A strict RFC 4180 reader, written here rather than taken as a dependency.
 *
 * The input is an operator's spreadsheet export — quoted fields containing
 * commas, newlines and escaped quotes are the normal case, not the exotic one,
 * and a `split(',')` would corrupt exactly the fields that matter (a licence
 * restriction paragraph, a title with a comma in it). It is small enough to
 * read in one sitting, which is the argument for owning it: a CSV parser is a
 * parser, and this milestone treats every byte of that file as untrusted input.
 *
 * What it deliberately does not do: infer types, trim significant whitespace,
 * or guess at a delimiter. A cell is a string; interpreting it is the caller's
 * job, done against a named column.
 */

export class CsvParseError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly line: number,
    detail: string,
  ) {
    super(`${filePath}: line ${line}: ${detail}`);
    this.name = 'CsvParseError';
  }
}

/** Splits a CSV document into rows of raw cells. */
export function parseCsv(text: string, filePath = '<csv>'): readonly (readonly string[])[] {
  // A UTF-8 BOM at the head of an Excel export would otherwise become part of
  // the first column's name and make every lookup for it miss.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let line = 1;
  let cellStarted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] as string;

    if (inQuotes) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === '\n') line += 1;
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      if (cellStarted && cell.length > 0) {
        throw new CsvParseError(filePath, line, 'a quote may only open at the start of a field');
      }
      inQuotes = true;
      cellStarted = true;
      continue;
    }
    if (char === ',') {
      row.push(cell);
      cell = '';
      cellStarted = false;
      continue;
    }
    if (char === '\r') continue;
    if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      cellStarted = false;
      line += 1;
      continue;
    }
    cell += char;
    cellStarted = true;
  }

  if (inQuotes) {
    throw new CsvParseError(filePath, line, 'the document ends inside a quoted field');
  }
  // A trailing newline produces one empty trailing row, which is not a record.
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((entry) => !(entry.length === 1 && entry[0]?.trim() === ''));
}

export interface CsvTable {
  readonly filePath: string;
  readonly columns: readonly string[];
  readonly rows: readonly CsvRow[];
}

export interface CsvRow {
  /** 1-based line in the source document, for error messages that can be acted on. */
  readonly line: number;
  get(column: string): string;
  has(column: string): boolean;
  readonly raw: readonly string[];
}

/**
 * Reads a CSV with a header row into named-column access.
 *
 * A missing column reads as an empty string rather than throwing: an operator's
 * inventory legitimately omits columns it has not filled in yet, and the
 * importer's job is to report what is missing per record rather than refuse the
 * whole document over a header. A *required* column is asserted by the caller,
 * where the requirement actually lives.
 */
export function readCsvTable(text: string, filePath: string): CsvTable {
  const rows = parseCsv(text, filePath);
  const header = rows[0];
  if (!header) throw new CsvParseError(filePath, 1, 'the document is empty');

  const columns = header.map((name) => name.trim());
  const index = new Map<string, number>();
  columns.forEach((name, position) => {
    if (!index.has(name)) index.set(name, position);
  });

  const records: CsvRow[] = rows.slice(1).map((cells, offset) => ({
    line: offset + 2,
    raw: cells,
    has: (column: string) => index.has(column),
    get: (column: string) => {
      const position = index.get(column);
      if (position === undefined) return '';
      return (cells[position] ?? '').trim();
    },
  }));

  return { filePath, columns, rows: records };
}

export function requireColumns(table: CsvTable, required: readonly string[]): readonly string[] {
  return required.filter((column) => !table.columns.includes(column));
}
