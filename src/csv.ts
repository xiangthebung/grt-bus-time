/**
 * Minimal streaming CSV reader tuned for GTFS text files.
 *
 * Papa Parse was previously used here, but its worker mode relies on a
 * `blob:` Worker URL which Chrome's MV3 extension CSP blocks, and its
 * per-row object allocation is wasteful for a 300k row `stop_times.txt`.
 * This reader walks the source string once and reuses a single field array.
 */

const COMMA = 44;
const QUOTE = 34;
const CR = 13;
const LF = 10;

export type CsvRowHandler = (fields: readonly string[]) => void;

/**
 * Parses `text` and invokes `onRow` for every data row.
 *
 * The array handed to `onRow` is reused between rows: copy any value you need
 * to keep. Returns the header row.
 */
export function parseCsv(text: string, onRow: CsvRowHandler): string[] {
  const length = text.length;
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let header: string[] | undefined;
  const fields: string[] = [];

  const endRow = (): void => {
    if (fields.length === 1 && fields[0] === "") {
      fields.length = 0;
      return;
    }
    if (header) onRow(fields);
    else header = [...fields];
    fields.length = 0;
  };

  while (index < length) {
    if (text.charCodeAt(index) === QUOTE) {
      index += 1;
      let value = "";
      let start = index;
      for (;;) {
        const quoteAt = text.indexOf('"', index);
        if (quoteAt === -1) {
          value += text.slice(start);
          index = length;
          break;
        }
        if (text.charCodeAt(quoteAt + 1) === QUOTE) {
          value += text.slice(start, quoteAt + 1);
          index = quoteAt + 2;
          start = index;
          continue;
        }
        value += text.slice(start, quoteAt);
        index = quoteAt + 1;
        break;
      }
      fields.push(value);
    } else {
      let end = index;
      while (end < length) {
        const code = text.charCodeAt(end);
        if (code === COMMA || code === LF || code === CR) break;
        end += 1;
      }
      fields.push(text.slice(index, end));
      index = end;
    }

    const code = text.charCodeAt(index);
    if (code === COMMA) {
      index += 1;
      continue;
    }
    if (code === CR) index += 1;
    if (text.charCodeAt(index) === LF) index += 1;
    endRow();
  }

  if (fields.length > 0) endRow();
  return header ?? [];
}

/** Reads just the header row, so column positions can be resolved up front. */
export function readCsvHeader(text: string): string[] {
  const lineEnd = text.indexOf("\n");
  const firstLine = lineEnd === -1 ? text : text.slice(0, lineEnd);
  return parseCsv(`${firstLine}\n`, () => undefined);
}

/** Resolves column positions once so row handlers can index directly. */
export function columnIndexes<T extends string>(
  header: readonly string[],
  columns: readonly T[],
): Record<T, number> {
  const positions = {} as Record<T, number>;
  for (const column of columns) {
    positions[column] = header.indexOf(column);
  }
  return positions;
}

/**
 * Parses a GTFS `HH:MM:SS` time into seconds after midnight of the service
 * day. Hours may exceed 23 for trips that run past midnight.
 */
export function parseGtfsTime(value: string | undefined): number {
  if (!value) return -1;
  let seconds = 0;
  let part = 0;
  let parts = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 58) {
      seconds = seconds * 60 + part;
      part = 0;
      parts += 1;
      continue;
    }
    if (code === 32) continue;
    if (code < 48 || code > 57) return -1;
    part = part * 10 + (code - 48);
  }
  if (parts !== 2) return -1;
  return seconds * 60 + part;
}

/** Fast non-negative integer parse. Returns -1 for anything unexpected. */
export function parseInteger(value: string | undefined): number {
  if (!value) return -1;
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return -1;
    result = result * 10 + (code - 48);
  }
  return result;
}
