// CSV-backed TableStore — wraps the existing csvIo helpers.
//
// Each `table` name maps to `<dataDir>/<table>.csv`. File locking and atomic
// rename semantics are inherited from csvIo / fileLock unchanged.

import path from 'node:path';

import { mutateCsv, readCsvUnlocked } from './csvIo';
import type { Row, TableStore } from './tableStore';

export class CsvTableStore implements TableStore {
  constructor(private readonly dataDir: string) {}

  read(table: string, header: readonly string[]): Promise<Row[]> {
    return readCsvUnlocked(this.filePath(table), header);
  }

  mutate(
    table: string,
    header: readonly string[],
    transform: (rows: Row[]) => Row[] | Promise<Row[]>,
  ): Promise<void> {
    return mutateCsv(this.filePath(table), header, transform);
  }

  private filePath(table: string): string {
    return path.join(this.dataDir, `${table}.csv`);
  }
}
