import { describe, expect, it } from 'vitest';
import { pingActivity } from './ping-activity';

describe('pingActivity', () => {
  it('echoes the message with a pong: prefix', async () => {
    await expect(pingActivity('hello')).resolves.toBe('pong:hello');
  });
});
