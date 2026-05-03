// Web-side time helpers — re-export from `src/shared/time.ts` so the
// web layer never reaches into shared by relative path. Keeps the
// "components.md / pages only depend on web/lib" rule clean.
//
// Adding a web-only helper? Put it here so the import surface stays single.

export {
  formatIst,
  formatIstDate,
  formatIstTime,
  istWallClockToUtc,
  startOfDayIstAsUtc,
  startOfNextDayIstAsUtc,
  todayIstIsoDate,
  tomorrowIstIsoDate,
  utcToIstWallClock,
} from '../../shared/time';
