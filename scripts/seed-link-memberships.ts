// Seed `data/link_memberships.csv` so every active LP and ALP belongs to
// a link.
//
// Strategy:
//   - Find LP links by `crewRole=LP` + name (CBE MAIL / CBE-8 PASSENGER).
//   - Find ALP mirror links by `crewRole=ALP` + same names.
//   - Bucket LPs by their `category` and seed each into the matching LP
//     link, round-robin across positions.
//   - Seed every active ALP into BOTH ALP links round-robin so ALP
//     coverage exists for every mail and every passenger run.
//   - Idempotent per (crewId, linkId): re-runs skip existing pairings.

import { CsvAssistantLocoPilotRepo } from '../src/persistence/csvAssistantLocoPilotRepo';
import { CsvLinkMembershipRepo } from '../src/persistence/csvLinkMembershipRepo';
import { CsvLinkRepo } from '../src/persistence/csvLinkRepo';
import { CsvLocoPilotRepo } from '../src/persistence/csvLocoPilotRepo';
import { CsvTableStore } from '../src/persistence/csvTableStore';
import { LpCategory } from '../src/domain/types';

const ANCHOR_DATE =
  process.env['ANCHOR_DATE'] ?? new Date().toISOString().slice(0, 10);

async function main(): Promise<void> {
  const store = new CsvTableStore('./data');
  const links = new CsvLinkRepo(store);
  const memberships = new CsvLinkMembershipRepo(store);
  const lps = new CsvLocoPilotRepo(store);
  const alps = new CsvAssistantLocoPilotRepo(store);

  const allLinks = await links.list();
  const lpMailLink = allLinks.find(
    (l) => l.crewRole === 'LP' && /MAIL/i.test(l.name),
  );
  const lpPassengerLink = allLinks.find(
    (l) => l.crewRole === 'LP' && /PASSENGER/i.test(l.name),
  );
  const alpMailLink = allLinks.find(
    (l) => l.crewRole === 'ALP' && /MAIL/i.test(l.name),
  );
  const alpPassengerLink = allLinks.find(
    (l) => l.crewRole === 'ALP' && /PASSENGER/i.test(l.name),
  );
  if (!lpMailLink) throw new Error('No LP mail link found');
  if (!lpPassengerLink) throw new Error('No LP passenger link found');
  if (!alpMailLink) throw new Error('No ALP mail link found');
  if (!alpPassengerLink) throw new Error('No ALP passenger link found');

  const allLps = await lps.list();
  const allAlps = await alps.list();
  const existing = await memberships.list();
  // Idempotency key is (crewId, linkId) so a crew can belong to multiple
  // links (e.g. an ALP in both mail + passenger ALP links).
  const seenPair = new Set(existing.map((m) => `${m.crewId}|${m.linkId}`));

  const byLpCategory = new Map<LpCategory, typeof allLps>([
    [LpCategory.MAIL_EXPRESS, []],
    [LpCategory.PASSENGER, []],
  ]);
  for (const lp of allLps) {
    byLpCategory.get(lp.category)?.push(lp);
  }

  let created = 0;
  // ---- LP links: one LP per category, round-robin ------------------------
  for (const [category, link] of [
    [LpCategory.MAIL_EXPRESS, lpMailLink] as const,
    [LpCategory.PASSENGER, lpPassengerLink] as const,
  ]) {
    const bucket = (byLpCategory.get(category) ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    for (let i = 0; i < bucket.length; i++) {
      const lp = bucket[i]!;
      if (seenPair.has(`${lp.id}|${link.id}`)) continue;
      const position = (i % link.cycleLength) + 1;
      await memberships.create({
        linkId: link.id,
        crewId: lp.id,
        crewRole: 'LP',
        anchorDate: ANCHOR_DATE,
        anchorPositionNumber: position,
      });
      created++;
      console.log(
        `+ ${link.name} pos ${String(position).padStart(2, '0')} ← ${lp.name}`,
      );
    }
  }

  // ---- ALP links: every active ALP into BOTH ALP links -------------------
  const sortedAlps = allAlps.slice().sort((a, b) => a.name.localeCompare(b.name));
  for (const link of [alpMailLink, alpPassengerLink]) {
    for (let i = 0; i < sortedAlps.length; i++) {
      const alp = sortedAlps[i]!;
      if (seenPair.has(`${alp.id}|${link.id}`)) continue;
      const position = (i % link.cycleLength) + 1;
      await memberships.create({
        linkId: link.id,
        crewId: alp.id,
        crewRole: 'ALP',
        anchorDate: ANCHOR_DATE,
        anchorPositionNumber: position,
      });
      created++;
      console.log(
        `+ ${link.name} pos ${String(position).padStart(2, '0')} ← ${alp.name}`,
      );
    }
  }

  console.log(`\nDone. Created ${created} membership(s). Anchor: ${ANCHOR_DATE}.`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
