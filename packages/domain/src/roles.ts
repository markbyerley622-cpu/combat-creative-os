import { z } from 'zod';

/**
 * The five roles fixed by the approved architecture (docs/architecture.md §2.2).
 * This is the domain-level source of truth for validation/API layers that must
 * not depend on @combat/database's Prisma client (e.g. the dashboard). The
 * Prisma schema defines its own mirrored `RoleName` enum for the same values —
 * see packages/database/prisma/schema.prisma for why that duplication is
 * intentional rather than a drift risk to silently resolve.
 */
export const ROLE_NAMES = [
  'OWNER_ADMIN',
  'CREATIVE_DIRECTOR',
  'PRODUCTION_OPERATOR',
  'REVIEWER',
  'ANALYST',
] as const;

export const RoleNameSchema = z.enum(ROLE_NAMES);

export type RoleName = z.infer<typeof RoleNameSchema>;

/**
 * Permission matrix from docs/architecture.md §2.2. This is the single source
 * of truth `packages/auth` (a later milestone) and `apps/api` must enforce
 * against — server-side only. UI visibility is never authorization.
 */
export const PERMISSIONS = [
  'CONFIGURE_PROVIDERS',
  'MANAGE_BUDGETS',
  'APPROVE_CONCEPT',
  'APPROVE_FINAL_MASTER',
  'SELECT_SHOTS',
  'PROVIDE_CANDIDATE_FEEDBACK',
  'TRIGGER_GENERATION',
  'MANAGE_ASSETS',
  'VIEW_REPORTING',
  'MANAGE_WORKSPACE_MEMBERSHIP',
] as const;

export const PermissionSchema = z.enum(PERMISSIONS);

export type Permission = z.infer<typeof PermissionSchema>;

export const ROLE_PERMISSIONS: Record<RoleName, readonly Permission[]> = {
  OWNER_ADMIN: [...PERMISSIONS],
  CREATIVE_DIRECTOR: ['APPROVE_CONCEPT', 'APPROVE_FINAL_MASTER', 'VIEW_REPORTING'],
  PRODUCTION_OPERATOR: ['TRIGGER_GENERATION', 'MANAGE_ASSETS', 'VIEW_REPORTING'],
  REVIEWER: ['SELECT_SHOTS', 'PROVIDE_CANDIDATE_FEEDBACK', 'VIEW_REPORTING'],
  ANALYST: ['VIEW_REPORTING'],
};

export function roleHasPermission(role: RoleName, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
