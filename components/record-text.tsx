import { decodeHTMLStrict } from 'entities/decode';
import { display } from '../lib/catalog';

export function recordText(column: string, value: unknown): string {
  const text = display(value);
  // Publisher titles may retain HTML entities after RSS/XML parsing. Decode one
  // layer for reading only; identifiers, URLs, filters and downloads stay exact.
  const title = column === 'title' || column.endsWith('_title') || column === 'heading';
  return title && typeof value === 'string' && text.includes('&') ? decodeHTMLStrict(text) : text;
}

export function RecordText({ column, value, showOriginal = false }: {
  column: string; value: unknown; showOriginal?: boolean;
}) {
  const text = recordText(column, value);
  const original = display(value);
  // Render as React text, never as HTML, including entity-encoded markup.
  return <>{text}{showOriginal && text !== original && <details className="record-original-text">
    <summary>Original source text</summary>
    <p>{original}</p>
  </details>}</>;
}
