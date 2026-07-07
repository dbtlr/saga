import { RecallSearchError, RecallSegmentNotFoundError } from '@saga/db';
import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import { runMcpRead } from './mcp.js';

// The MCP handlers run through runMcpRead, which must never forward a stack, a raw
// driver message, or an unrecognized typed-error message to the caller — the
// @saga/mcp core would surface that verbatim in its -32000 error, leaking it. Only
// the not-found error (a hand-authored constant, no driver text) is forwarded.
describe('runMcpRead defect + error hardening', () => {
  it('sanitizes a DEFECT to a static message and logs the cause server-side', async () => {
    const spy = vi.spyOn(console, 'error').mockReturnValue(undefined);
    try {
      const error = await runMcpRead(() =>
        Effect.die(new Error('pg: connection terminated\n  at internal/stack/frame')),
      ).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('internal error');
      expect((error as Error).message).not.toMatch(/pg:|stack|frame/u);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('sanitizes a wrapped-pg typed failure (RecallSearchError) rather than leaking the driver text', async () => {
    const spy = vi.spyOn(console, 'error').mockReturnValue(undefined);
    try {
      const error = await runMcpRead(() =>
        Effect.fail(
          new RecallSearchError({
            message: 'invalid input syntax for type uuid: "not-a-uuid"',
          }),
        ),
      ).catch((cause: unknown) => cause);
      expect((error as Error).message).toBe('internal error');
      expect((error as Error).message).not.toContain('uuid');
      expect((error as Error).message).not.toContain('invalid input syntax');
    } finally {
      spy.mockRestore();
    }
  });

  it('forwards the not-found error, whose constant message carries no driver text', async () => {
    const error = await runMcpRead(() =>
      Effect.fail(
        new RecallSegmentNotFoundError({ message: 'recall segment was not found in workspace' }),
      ),
    ).catch((cause: unknown) => cause);
    expect((error as Error).message).toBe('recall segment was not found in workspace');
  });

  it('sanitizes a synchronous throw during Effect construction', async () => {
    const spy = vi.spyOn(console, 'error').mockReturnValue(undefined);
    try {
      const error = await runMcpRead((): Effect.Effect<never> => {
        throw new Error('pg secret /Users/someone/db.sock');
      }).catch((cause: unknown) => cause);
      expect((error as Error).message).toBe('internal error');
      expect((error as Error).message).not.toContain('/Users/');
    } finally {
      spy.mockRestore();
    }
  });

  it('returns the value on success', async () => {
    await expect(runMcpRead(() => Effect.succeed(42))).resolves.toBe(42);
  });
});
