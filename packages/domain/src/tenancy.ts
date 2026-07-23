import { z } from 'zod';
import { RoleNameSchema } from './roles';

export const WorkspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with hyphens only'),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().min(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type User = z.infer<typeof UserSchema>;

export const MembershipSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
  role: RoleNameSchema,
  createdAt: z.date(),
});
export type Membership = z.infer<typeof MembershipSchema>;

/**
 * Every mutating/read repository call in packages/database is expected to
 * accept this as its first argument. It exists as a distinct type (rather
 * than a bare string) so a call site cannot accidentally pass a campaignId or
 * userId where a workspaceId is expected.
 */
export const WorkspaceScopeSchema = z.object({
  workspaceId: z.string().uuid(),
});
export type WorkspaceScope = z.infer<typeof WorkspaceScopeSchema>;
