// `archiveAssignment` — application-layer orchestrator for the Delete-an-
// assignment flow.
//
// Why an orchestrator and not a thin repo passthrough? Archiving the row is
// the easy part — what makes this non-trivial is rolling the LP and ALP rest
// clocks back to whatever value they carried *before* this assignment
// stamped a new sign-off on them. That snapshot lives on the Assignment row
// itself (`previousLpSignOffTime` / `previousAlpSignOffTime`), captured by
// `assignCrew` at create-time and rotated by `updateAssignment` on edit.
//
// The flow:
//   1. Load the assignment (must be active — no-op for already-archived rows
//      so retries are idempotent).
//   2. Restore `lp.lastSignOffTime` to `assignment.previousLpSignOffTime`
//      (clearing the field if the LP had never signed off before).
//   3. Same for the ALP, when one was assigned.
//   4. Archive the row.
//
// Order matters: we restore crew BEFORE archiving the assignment so that, if
// the rest restore succeeds and the archive fails, retrying the archive will
// still find the snapshot on an active row. The reverse order would leave us
// with an archived row and un-restored crew clocks.
//
// Layering: this is the second application-layer write path on assignments,
// alongside `assignCrew` and `updateAssignment`. No domain rules apply on
// archive (you can always cancel an assignment), so the function returns a
// plain `Promise<void>` and surfaces operational errors as exceptions.

import {
  AssignmentRepo,
  AssistantLocoPilotRepo,
  LocoPilotRepo,
} from '../domain/repositories';

export interface ArchiveAssignmentDeps {
  lps: LocoPilotRepo;
  alps: AssistantLocoPilotRepo;
  assignments: AssignmentRepo;
}

/**
 * Archive an active assignment and roll the LP/ALP rest clocks back to the
 * snapshot captured when the assignment was created. Idempotent — calling on
 * an already-archived row is a no-op (no double-rollback, no exception).
 */
export async function archiveAssignment(
  deps: ArchiveAssignmentDeps,
  assignmentId: string,
): Promise<void> {
  const existing = await deps.assignments.findById(assignmentId, {
    includeArchived: true,
  });
  if (!existing) {
    throw new Error(`archiveAssignment: assignment not found: ${assignmentId}`);
  }
  if (existing.archivedAt) {
    // Already archived. Operator's intent is satisfied; we deliberately do
    // NOT re-restore the rest clocks because they may have been overwritten
    // by a later assignment in the meantime.
    return;
  }

  // ----- Restore crew rest clocks BEFORE archiving the row, so a partial
  //       failure leaves the snapshot reachable for a retry.
  await deps.lps.update(existing.lpId, {
    lastSignOffTime: existing.previousLpSignOffTime,
  });
  if (existing.alpId) {
    await deps.alps.update(existing.alpId, {
      lastSignOffTime: existing.previousAlpSignOffTime,
    });
  }

  await deps.assignments.archive(existing.id);
}
