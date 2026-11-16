import * as XLSX from 'xlsx';

export type CellValue = string | number | boolean | Date | null;

export interface SheetSummary {
  name: string;
  /** Raw rows as read, before header selection. Capped for preview purposes. */
  previewRows: CellValue[][];
  totalRows: number;
  totalColumns: number;
}

export interface LoadedWorkbook {
  fileName: string;
  fileSize: number;
  sheetNames: string[];
  sheets: Record<string, SheetSummary>;
  /** Kept so a sheet can be fully extracted after the user picks one. */
  raw: XLSX.WorkBook;
}

const PREVIEW_ROW_LIMIT = 40;

function toCellValue(value: unknown): CellValue {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  return String(value);
}

/** Reads a File into a workbook. Throws a user-readable Error on failure. */
export async function loadWorkbook(file: File): Promise<LoadedWorkbook> {
  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    throw new Error('The file could not be read from disk.');
  }

  let book: XLSX.WorkBook;
  try {
    book = XLSX.read(buffer, {
      type: 'array',
      cellDates: true,
      // Keep raw values; formatting is irrelevant and slows large files down.
      cellNF: false,
      cellStyles: false,
      cellText: false,
      dense: false,
    });
  } catch (err) {
    throw new Error(
      `The file is not a readable spreadsheet (${
        err instanceof Error ? err.message : 'unknown parser error'
      }).`,
    );
  }

  if (!book.SheetNames.length) {
    throw new Error('The workbook contains no worksheets.');
  }

  const sheets: Record<string, SheetSummary> = {};
  for (const name of book.SheetNames) {
    const sheet = book.Sheets[name];
    if (!sheet) continue;
    const ref = sheet['!ref'];
    const range = ref ? XLSX.utils.decode_range(ref) : null;
    const totalRows = range ? range.e.r - range.s.r + 1 : 0;
    const totalColumns = range ? range.e.c - range.s.c + 1 : 0;

    const previewRange =
      range && totalRows > PREVIEW_ROW_LIMIT
        ? XLSX.utils.encode_range({
            s: range.s,
            e: { r: range.s.r + PREVIEW_ROW_LIMIT - 1, c: range.e.c },
          })
        : ref;

    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: true,
      ...(previewRange ? { range: previewRange } : {}),
    });

    sheets[name] = {
      name,
      previewRows: rows.map((row) => (row ?? []).map(toCellValue)),
      totalRows,
      totalColumns,
    };
  }

  return {
    fileName: file.name,
    fileSize: file.size,
    sheetNames: book.SheetNames.filter((n) => sheets[n]),
    sheets,
    raw: book,
  };
}

/** Full row extraction for a chosen sheet, as an array of arrays. */
export function extractSheetRows(book: XLSX.WorkBook, sheetName: string): CellValue[][] {
  const sheet = book.Sheets[sheetName];
  if (!sheet) throw new Error(`Worksheet "${sheetName}" is not present in the workbook.`);
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  });
  return rows.map((row) => (row ?? []).map(toCellValue));
}

export function cellToString(value: CellValue): string {
  if (value === null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    // Avoid 1.0000000001 style artifacts from float columns.
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
  }
  return value.trim();
}

/**
 * Parses a cell into a non-negative integer quantity.
 * Returns null when the value is genuinely unknown — never 0 as a fallback.
 */
export function cellToQuantity(value: CellValue): { quantity: number | null; error: string | null } {
  if (value === null) return { quantity: null, error: 'empty' };
  if (value instanceof Date) return { quantity: null, error: 'date value in quantity column' };
  if (typeof value === 'boolean') return { quantity: null, error: 'boolean value in quantity column' };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { quantity: null, error: 'not a finite number' };
    if (value < 0) return { quantity: null, error: 'negative quantity' };
    return { quantity: Math.round(value), error: null };
  }

  const text = value.trim();
  if (!text) return { quantity: null, error: 'empty' };
  // Tolerate thousands separators and stray whitespace, reject anything else.
  const cleaned = text.replace(/[\s,]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    return { quantity: null, error: `not numeric ("${text.slice(0, 40)}")` };
  }
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return { quantity: null, error: `not numeric ("${text.slice(0, 40)}")` };
  if (num < 0) return { quantity: null, error: 'negative quantity' };
  return { quantity: Math.round(num), error: null };
}
