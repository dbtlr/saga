import { createServerFn } from "@tanstack/react-start";
import { readControlPlaneSnapshot } from "./control-plane.js";

export const getControlPlaneSnapshot = createServerFn({ method: "GET" }).handler(() =>
  readControlPlaneSnapshot(),
);
