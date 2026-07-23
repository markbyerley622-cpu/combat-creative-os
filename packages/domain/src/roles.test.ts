import { describe, expect, it } from 'vitest';
import { roleHasPermission, ROLE_NAMES, RoleNameSchema } from './roles';

describe('roles', () => {
  it('accepts exactly the five approved roles', () => {
    expect(ROLE_NAMES).toEqual([
      'OWNER_ADMIN',
      'CREATIVE_DIRECTOR',
      'PRODUCTION_OPERATOR',
      'REVIEWER',
      'ANALYST',
    ]);
  });

  it('rejects an unknown role', () => {
    expect(() => RoleNameSchema.parse('SUPER_USER')).toThrow();
  });

  it('grants OWNER_ADMIN every permission', () => {
    expect(roleHasPermission('OWNER_ADMIN', 'APPROVE_FINAL_MASTER')).toBe(true);
    expect(roleHasPermission('OWNER_ADMIN', 'SELECT_SHOTS')).toBe(true);
  });

  it('does not grant ANALYST any mutating permission', () => {
    expect(roleHasPermission('ANALYST', 'APPROVE_CONCEPT')).toBe(false);
    expect(roleHasPermission('ANALYST', 'SELECT_SHOTS')).toBe(false);
    expect(roleHasPermission('ANALYST', 'VIEW_REPORTING')).toBe(true);
  });

  it('only REVIEWER and OWNER_ADMIN can select shots', () => {
    expect(roleHasPermission('REVIEWER', 'SELECT_SHOTS')).toBe(true);
    expect(roleHasPermission('CREATIVE_DIRECTOR', 'SELECT_SHOTS')).toBe(false);
    expect(roleHasPermission('PRODUCTION_OPERATOR', 'SELECT_SHOTS')).toBe(false);
  });
});
