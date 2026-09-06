import 'dotenv/config';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';

// Seed safety for the corporate daily checklists (Milestone 6B-2, applied
// to both Opening and Closing in 6D).
//
// Milestone 6B re-seeded ChecklistTemplateItem on every run (delete +
// create). That is no longer safe: HQ manages those items (wording, active
// state, ordering, sections) through the Admin UI. The seed is CREATE-ONCE
// — it populates the standard items only when the template has none, and
// never touches them afterwards.
//
// This test runs the REAL seed script against the local database, having
// first made a spread of HQ-style edits to EACH checklist, and proves every
// one survives. It restores each template to its seeded snapshot after
// every case so later specs see clean data.
describe('daily-checklist seed is create-once (integration)', () => {
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

  type Snapshot = {
    id: string;
    section: string;
    label: string;
    sortOrder: number;
    isActive: boolean;
  }[];

  const templateIds: Record<string, string> = {};
  const snapshots: Record<string, Snapshot> = {};
  const addedItemIds: string[] = [];

  function runSeed(): void {
    execSync('pnpm exec tsx prisma/seed.ts', {
      cwd: databaseDir,
      stdio: 'pipe',
    });
  }

  async function restore(key: string): Promise<void> {
    await prisma.checklistTemplateItem.deleteMany({
      where: {
        templateId: templateIds[key],
        id: { notIn: snapshots[key].map((s) => s.id) },
      },
    });
    for (const original of snapshots[key]) {
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
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    await prisma.onModuleInit();

    for (const key of ['opening', 'closing']) {
      const template = await prisma.checklistTemplate.findUniqueOrThrow({
        where: { key },
      });
      templateIds[key] = template.id;
      snapshots[key] = (
        await prisma.checklistTemplateItem.findMany({
          where: { templateId: template.id },
          orderBy: { sortOrder: 'asc' },
        })
      ).map((i) => ({
        id: i.id,
        section: i.section,
        label: i.label,
        sortOrder: i.sortOrder,
        isActive: i.isActive,
      }));
    }
  }, 30_000);

  afterEach(async () => {
    for (const id of addedItemIds.splice(0)) {
      await prisma.checklistTemplateItem
        .delete({ where: { id } })
        .catch(() => undefined);
    }
    await restore('opening');
    await restore('closing');
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it.each(['opening', 'closing'])(
    'preserves HQ wording, active state, additions, section rename and order across a reseed (%s)',
    async (key) => {
      const templateId = templateIds[key];
      const snapshot = snapshots[key];
      const [first, second, , deactivated] = snapshot;

      await prisma.checklistTemplateItem.update({
        where: { id: first.id },
        data: { label: `HQ REWORDED ${key}` },
      });
      await prisma.checklistTemplateItem.update({
        where: { id: deactivated.id },
        data: { isActive: false },
      });
      await prisma.checklistTemplateItem.update({
        where: { id: second.id },
        data: { sortOrder: 0 },
      });
      await prisma.checklistTemplateItem.updateMany({
        where: { templateId, section: first.section },
        data: { section: `${first.section} (renamed)` },
      });
      const added = await prisma.checklistTemplateItem.create({
        data: {
          templateId,
          section: 'HQ New Section',
          label: `HQ ADDED to ${key}`,
          sortOrder: 999,
          isActive: true,
        },
      });
      addedItemIds.push(added.id);

      const countBefore = await prisma.checklistTemplateItem.count({
        where: { templateId },
      });
      expect(countBefore).toBe(snapshot.length + 1);

      runSeed();

      const after = await prisma.checklistTemplateItem.findMany({
        where: { templateId },
        orderBy: { sortOrder: 'asc' },
      });

      expect(after).toHaveLength(countBefore);
      expect(after.find((i) => i.id === first.id)?.label).toBe(
        `HQ REWORDED ${key}`,
      );
      expect(after.find((i) => i.id === deactivated.id)?.isActive).toBe(false);
      expect(after.find((i) => i.id === second.id)?.sortOrder).toBe(0);
      const sections = new Set(after.map((i) => i.section));
      expect(sections.has(`${first.section} (renamed)`)).toBe(true);
      expect(sections.has(first.section)).toBe(false);
      expect(after.find((i) => i.id === added.id)?.label).toBe(
        `HQ ADDED to ${key}`,
      );
    },
    60_000,
  );

  it('a reseed re-populates a checklist template that has been fully emptied', async () => {
    await prisma.checklistInstanceItem.deleteMany({
      where: { checklistInstance: { template: { key: 'closing' } } },
    });
    await prisma.checklistInstance.deleteMany({
      where: { template: { key: 'closing' } },
    });
    await prisma.checklistTemplateItem.deleteMany({
      where: { templateId: templateIds['closing'] },
    });

    runSeed();

    const reseeded = await prisma.checklistTemplateItem.findMany({
      where: { templateId: templateIds['closing'] },
      orderBy: { sortOrder: 'asc' },
    });
    expect(reseeded).toHaveLength(14);
    expect(reseeded[0].label).toBe(
      'Properly store all perishable food items using FIFO.',
    );

    // The freshly seeded rows have new ids — re-point the snapshot so
    // afterEach/afterAll restore is a no-op rather than a failure.
    snapshots['closing'] = reseeded.map((i) => ({
      id: i.id,
      section: i.section,
      label: i.label,
      sortOrder: i.sortOrder,
      isActive: i.isActive,
    }));
  }, 60_000);
});
