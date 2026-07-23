import { PrismaClient } from '@prisma/client';

/**
 * Seeds the single-workspace MVP (docs/architecture.md §4.4): one workspace,
 * one OWNER_ADMIN user, and the membership linking them. Safe to re-run —
 * upserts on the unique slug/email.
 */
async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const workspace = await prisma.workspace.upsert({
      where: { slug: 'combat-reviews' },
      update: {},
      create: { name: 'Combat Reviews', slug: 'combat-reviews' },
    });

    const owner = await prisma.user.upsert({
      where: { email: 'owner@combatreviews.local' },
      update: {},
      create: { email: 'owner@combatreviews.local', displayName: 'Workspace Owner' },
    });

    await prisma.membership.upsert({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: owner.id } },
      update: { role: 'OWNER_ADMIN' },
      create: { workspaceId: workspace.id, userId: owner.id, role: 'OWNER_ADMIN' },
    });

    // eslint-disable-next-line no-console
    console.log(`Seeded workspace "${workspace.slug}" with owner "${owner.email}".`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
