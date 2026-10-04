/**
 * Content negotiation for generated documents.
 *
 * When a browser requests a PDF with `Accept: application/pdf` we inline it (so
 * a new tab can preview it); Excel exports and everything else are attachments.
 */
export function fileNegotiation(
  acceptHeader: string | undefined,
  fileName: string,
  options: { forceAttachment?: boolean; contentType?: string } = {},
): { contentType: string; disposition: string } {
  const accept = acceptHeader ?? '';
  const isPdf = fileName.toLowerCase().endsWith('.pdf');
  const contentType = options.contentType ?? (isPdf ? 'application/pdf' : 'application/octet-stream');
  const inline = isPdf && !options.forceAttachment && accept.includes('application/pdf');
  return {
    contentType,
    disposition: `${inline ? 'inline' : 'attachment'}; filename="${fileName.replace(/"/g, '')}"`,
  };
}

/** RFC-4180 CSV escaping for the Excel/CSV fallbacks. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
