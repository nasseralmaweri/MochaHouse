import 'dotenv/config';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';

// Seed safety for the corporate Opening Checklist (Milestone 6B-2).
//
// Milestone 6B re-seeded ChecklistTemplateItem on every run (delete + create).
// That is no longer safe: HQ now manages those items (wording, active state,
// ordering, sections) through the Admin UI. 6B-2 makes the seed CREATE-ONCE
// — it populates the 23-item standard only when the template has no items,
// and never touches them afterwards.
//
// This test runs the REAL seed script against the local database, having
// first made a spread of HQ-style edits, and proves every one survives.
describe('Opening Checklist seed is create-once (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  const databaseDir = join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'packages',
    'database',
  );

  let templateId: string;
  let snapshot: {
    id: string;
    section: string;
    label: string;
    sortOrder: number;
    isActive: boolean;
  }[] = [];
  let addedItemId: string | null = null;

  function runSeed(): void {
    // Runs the real seed exactly as `prisma db seed` would (see
    // packages/database/prisma.config.ts).
    execSync('pnpm exec tsx prisma/seed.ts', {
      cwd: databaseDir,
      stdio: 'pipe',
    });
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    await prisma.onModuleInit();

    const template = await prisma.checklistTemplate.findUniqueOrThrow({
      where: { key: 'opening' },
    });
    templateId = template.id;
    snapshot = (
      await prisma.checklistTemplateItem.findMany({
        where: { templateId },
        orderBy: { sortOrder: 'asc' },
      })
    ).map((i) => ({
      id: i.id,
      section: i.section,
      label: i.label,
      sortOrder: i.sortOrder,
      isActive: i.isActive,
    }));
  }, 30_000);

  afterAll(async () => {
    if (addedItemId) {
      await prisma.checklistTemplateItem
        .delete({ where: { id: addedItemId } })
        .catch(() => undefined);
    }
    for (const original of snapshot) {
      await prisma.checklistTemplateItem.update({
        where: { id: original.id },
        data: {
          section: original.section,
          label: original.label,
          sortOrder: original.sortOrder,
          isActive: original.isActive,
        },
      });
    }
    await moduleRef.close();
  });

  it('preserves HQ wording, active state, additions, sections and order across a reseed', async () => {
    // A spread of HQ-style edits, applied directly.
    const first = snapshot[0];
    const deactivated = snapshot[3];
    await prisma.checklistTemplateItem.update({
      where: { id: first.id },
      data: { label: 'HQ REWORDED THIS ITEM' },
    });
    await prisma.checklistTemplateItem.update({
      where: { id: deactivated.id },
      data: { isActive: false },
    });
    // A reorder: bump the second item to the front of its section.
    const second = snapshot[1];
    await prisma.checklistTemplateItem.update({
      where: { id: second.id },
      data: { sortOrder: 0 },
    });
    // A section rename for the whole "Equipment" block.
    await prisma.checklistTemplateItem.updateMany({
      where: { templateId, section: 'Equipment' },
      data: { section: 'Machines & Equipment' },
    });
    // A brand-new HQ item.
    const added = await prisma.checklistTemplateItem.create({
      data: {
        templateId,
        section: 'Building & Security',
        label: 'HQ ADDED: prop the back door for deliveries.',
        sortOrder: 999,
        isActive: true,
      },
    });
    addedItemId = added.id;

    const countBefore = await prisma.checklistTemplateItem.count({
      where: { templateId },
    });
    expect(countBefore).toBe(snapshot.length + 1);

    runSeed();

    const after = await prisma.checklistTemplateItem.findMany({
      where: { templateId },
      orderBy: { sortOrder: 'asc' },
    });

    // Nothing was deleted or recreated.
    expect(after).toHaveLength(countBefore);
    // The reworded item kept its new wording.
    expect(after.find((i) => i.id === first.id)?.label).toBe(
      'HQ REWORDED THIS ITEM',
    );
    // The deactivated item is still inactive.
    expect(after.find((i) => i.id === deactivated.id)?.isActive).toBe(false);
    // The reorder held.
    expect(after.find((i) => i.id === second.id)?.sortOrder).toBe(0);
    // The section rename held; the old name is gone.
    const sections = new Set(after.map((i) => i.section));
    expect(sections.has('Machines & Equipment')).toBe(true);
    expect(sections.has('Equipment')).toBe(false);
    // The HQ-added item still exists.
    expect(after.find((i) => i.id === added.id)?.label).toBe(
      'HQ ADDED: prop the back door for deliveries.',
    );
  }, 60_000);
});
