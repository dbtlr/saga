import { createServerFn } from "@tanstack/react-start";
import {
  readControlPlaneSnapshot,
  updateClaimReview,
  updateSourceBinding,
  updateWorkspaceProfile,
  type UpdateClaimReviewInput,
  type UpdateSourceBindingInput,
  type UpdateWorkspaceProfileInput,
} from "./control-plane.js";

export const getControlPlaneSnapshot = createServerFn({ method: "GET" }).handler(() =>
  readControlPlaneSnapshot(),
);

export const saveWorkspaceProfile = createServerFn({ method: "POST" })
  .validator((data: UpdateWorkspaceProfileInput) => ({
    displayName: data.displayName,
    summary: data.summary,
  }))
  .handler(async ({ data }) => {
    await updateWorkspaceProfile(data);
    return { ok: true };
  });

export const saveSourceBinding = createServerFn({ method: "POST" })
  .validator((data: UpdateSourceBindingInput) => ({
    displayName: data.displayName,
    enabled: data.enabled,
    id: data.id,
  }))
  .handler(async ({ data }) => {
    await updateSourceBinding(data);
    return { ok: true };
  });

export const reviewClaim = createServerFn({ method: "POST" })
  .validator((data: UpdateClaimReviewInput) => ({
    action: data.action,
    claimKey: data.claimKey,
  }))
  .handler(async ({ data }) => {
    await updateClaimReview(data);
    return { ok: true };
  });
