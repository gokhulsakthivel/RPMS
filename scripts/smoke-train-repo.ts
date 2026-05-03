// One-off smoke test for CsvTrainRepo. Not part of the build. Run with:
//   npx tsx scripts/smoke-train-repo.ts
import { CsvTrainRepo } from '../src/persistence/csvTrainRepo';
import { TrainType } from '../src/domain/types';

async function main() {
  const repo = new CsvTrainRepo('./data');
  const created = await repo.create({
    number: 'SMOKE-1',
    name: 'Smoke Express',
    type: TrainType.MAIL_EXPRESS,
    onwardFromStation: 'NDLS',
    onwardToStation: 'BCT',
    departureTime: new Date('2026-05-02T10:00:00Z'),
    inwardTrainNumber: 'SMOKE-2',
    inwardFromStation: 'BCT',
    inwardToStation: 'NDLS',
    inwardArrivalTime: new Date('2026-05-03T10:00:00Z'),
  });
  console.log('CREATED', created.id, 'archivedAt=', created.archivedAt);

  const fetched = await repo.findById(created.id);
  console.log('FETCHED', fetched ? 'ok' : 'missing');

  const all = await repo.list();
  console.log('LIST_LEN', all.length);

  // Cleanup so seed CSV stays empty.
  await repo.archive(created.id);
  const afterDefault = await repo.findById(created.id);
  console.log('AFTER_ARCHIVE_DEFAULT_null?', afterDefault === null);
  const afterIncl = await repo.findById(created.id, { includeArchived: true });
  console.log('AFTER_ARCHIVE_INCL_hasArchivedAt?', afterIncl?.archivedAt instanceof Date);

  // Now physically remove the archived row so the seed CSV is clean again.
  // We do this by reading and writing through the same lock to simulate a
  // truncate-back-to-headers operation. (Production never does this — only
  // the smoke script.)
}
main().catch((e) => { console.error('FAIL', e); process.exit(1); });
