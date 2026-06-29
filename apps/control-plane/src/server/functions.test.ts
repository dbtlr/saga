import { describe, expect, it } from 'vitest';

import {
  validateClaimReviewInput,
  validateSourceBindingInput,
  validateWorkspaceProfileInput,
} from './functions.js';

describe('server function validators', () => {
  it('accepts valid workspace profile payloads', () => {
    expect(
      validateWorkspaceProfileInput({ displayName: 'Saga', summary: 'Memory system' }),
    ).toStrictEqual({
      displayName: 'Saga',
      summary: 'Memory system',
    });
  });

  it('rejects malformed source binding payloads', () => {
    expect(() =>
      validateSourceBindingInput({ displayName: 'Codex', enabled: 'yes', id: 'source-1' }),
    ).toThrow('enabled must be a boolean');
  });

  it('rejects unsupported claim review actions', () => {
    expect(() => validateClaimReviewInput({ action: 'delete', claimKey: 'claim-1' })).toThrow(
      'action must be a supported claim review action',
    );
  });

  it('accepts claim promotion actions', () => {
    expect(validateClaimReviewInput({ action: 'promote', claimKey: 'claim-1' })).toStrictEqual({
      action: 'promote',
      claimKey: 'claim-1',
    });
  });
});
