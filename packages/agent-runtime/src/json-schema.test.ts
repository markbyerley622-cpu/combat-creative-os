import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toStrictJsonSchema } from './json-schema';

describe('toStrictJsonSchema', () => {
  it('sets additionalProperties: false on every object level', () => {
    const schema = z.object({
      name: z.string().min(1),
      nested: z.object({ count: z.number().int().min(0) }),
    });

    const jsonSchema = toStrictJsonSchema(schema, 'test_tool') as {
      properties: { nested: { additionalProperties: boolean } };
      additionalProperties: boolean;
    };

    expect(jsonSchema.additionalProperties).toBe(false);
    expect(jsonSchema.properties.nested.additionalProperties).toBe(false);
  });

  it('strips length/range constraints Claude strict tool schemas do not support', () => {
    const schema = z.object({ name: z.string().min(1).max(100), count: z.number().min(0).max(10) });
    const jsonSchema = JSON.stringify(toStrictJsonSchema(schema, 'test_tool'));

    expect(jsonSchema).not.toContain('minLength');
    expect(jsonSchema).not.toContain('maxLength');
    expect(jsonSchema).not.toContain('minimum');
    expect(jsonSchema).not.toContain('maximum');
  });

  it('preserves required/enum/format, which Claude strict schemas do support', () => {
    const schema = z.object({
      status: z.enum(['PASS', 'FAIL']),
      id: z.string().uuid(),
    });
    const jsonSchema = toStrictJsonSchema(schema, 'test_tool') as {
      required: string[];
      properties: { status: { enum: string[] }; id: { format: string } };
    };

    expect(jsonSchema.required).toEqual(expect.arrayContaining(['status', 'id']));
    expect(jsonSchema.properties.status.enum).toEqual(['PASS', 'FAIL']);
    expect(jsonSchema.properties.id.format).toBe('uuid');
  });
});
