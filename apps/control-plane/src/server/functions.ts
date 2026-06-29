import { createServerFn } from '@tanstack/react-start';

import {
  readControlPlaneSnapshot,
  updateClaimReview,
  updateSourceBinding,
  updateWorkspaceProfile,
} from './control-plane.js';
import type {
  UpdateClaimReviewInput,
  UpdateSourceBindingInput,
  UpdateWorkspaceProfileInput,
} from './control-plane.js';

export const getControlPlaneSnapshot = createServerFn({ method: 'GET' }).handler(() =>
  readControlPlaneSnapshot(),
);

export const saveWorkspaceProfile = createServerFn({ method: 'POST' })
  .validator(validateWorkspaceProfileInput)
  .handler(async ({ data }) => {
    await updateWorkspaceProfile(data);
    return { ok: true };
  });

export const saveSourceBinding = createServerFn({ method: 'POST' })
  .validator(validateSourceBindingInput)
  .handler(async ({ data }) => {
    await updateSourceBinding(data);
    return { ok: true };
  });

export const reviewClaim = createServerFn({ method: 'POST' })
  .validator(validateClaimReviewInput)
  .handler(async ({ data }) => {
    await updateClaimReview(data);
    return { ok: true };
  });

export function validateWorkspaceProfileInput(data: unknown): UpdateWorkspaceProfileInput {
  const record = requireRecord(data);
  return {
    displayName: requireString(record.displayName, 'displayName'),
    summary: requireString(record.summary, 'summary'),
  };
}

export function validateSourceBindingInput(data: unknown): UpdateSourceBindingInput {
  const record = requireRecord(data);
  return {
    displayName: requireString(record.displayName, 'displayName'),
    enabled: requireBoolean(record.enabled, 'enabled'),
    id: requireString(record.id, 'id'),
  };
}

export function validateClaimReviewInput(data: unknown): UpdateClaimReviewInput {
  const record = requireRecord(data);
  const action = requireString(record.action, 'action');
  if (!isClaimReviewAction(action)) {
    throw new Error('action must be a supported claim review action');
  }

  return {
    action,
    claimKey: requireString(record.claimKey, 'claimKey'),
  };
}

function requireRecord(data: unknown): Record<string, unknown> {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('payload must be an object');
  }

  return data as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }

  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${field} must be a boolean`);
  }

  return value;
}

function isClaimReviewAction(value: string): value is UpdateClaimReviewInput['action'] {
  return (
    value === 'accept' ||
    value === 'pin' ||
    value === 'promote' ||
    value === 'reject' ||
    value === 'unpin' ||
    value === 'unwatch' ||
    value === 'watch'
  );
}
