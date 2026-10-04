/**
 * Excel (OOXML) builders for report exports.
 *
 * exceljs produces a real .xlsx workbook with a styled header row, frozen panes
 * and auto filters - the format accountants actually work with in Excel.
 */
import ExcelJS from 'exceljs';
import { formatDhakaDateTime } from '../../utils/dates';

export interface SheetColumn {
  header: string;
  key: string;
  width?: number;
  /** money values are already poisha strings; render as BDT numbers */
  money?: boolean;
  date?: boolean;
}

export interface SheetSpec {
  name: string;
  columns: SheetColumn[];
  rows: Array<Record<string, unknown>>;
  /** optional totals row (money columns are summed) */
  totals?: Record<string, unknown>;
}

const HEADER_FILL = 'FF1E293B';
const MONEY_FORMAT = '#,##0.00';

/** Converts a poisha value (string|bigint|number) into BDT for Excel. */
export function poishaToBdtNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  try {
    return Number(BigInt(String(value))) / 100;
  } catch {
    return null;
  }
}

export async function buildWorkbook(sheets: SheetSpec[], meta?: { title?: string }): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Investor Installment Portal';
  workbook.created = new Date();
  if (meta?.title) workbook.title = meta.title;

  for (const spec of sheets) {
    const sheet = workbook.addWorksheet(spec.name, {
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    sheet.columns = spec.columns.map((column) => ({
      header: column.header,
      key: column.key,
      width: column.width ?? Math.max(14, column.header.length + 4),
      style: column.money ? { numFmt: MONEY_FORMAT } : column.date ? { numFmt: 'yyyy-mm-dd hh:mm' } : undefined,
    }));

    const header = sheet.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    header.alignment = { vertical: 'middle' };
    header.height = 20;

    for (const row of spec.rows) {
      const prepared: Record<string, unknown> = {};
      for (const column of spec.columns) {
        const raw = row[column.key];
        prepared[column.key] = column.money ? poishaToBdtNumber(raw) : column.date && raw ? new Date(String(raw)) : raw ?? '';
      }
      sheet.addRow(prepared);
    }

    if (spec.totals) {
      const totalsRow: Record<string, unknown> = {};
      for (const column of spec.columns) {
        const value = spec.totals[column.key];
        totalsRow[column.key] =
          column.money && value !== undefined ? poishaToBdtNumber(value) : value ?? (column.money ? undefined : '');
      }
      const row = sheet.addRow(totalsRow);
      row.font = { bold: true };
    }

    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: spec.columns.length } };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export function exportFileName(prefix: string): string {
  return `${prefix}-${formatDhakaDateTime(new Date()).replace(/[: ]/g, '-')}.xlsx`;
}

export const excelService = { buildWorkbook, exportFileName, poishaToBdtNumber };
export default excelService;
