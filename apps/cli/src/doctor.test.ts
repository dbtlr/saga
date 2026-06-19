import { describe, expect, test } from "vitest";
import { renderDoctor, type DoctorCheck } from "./doctor.js";

const checks: DoctorCheck[] = [
  {
    detail: "v26.3.1",
    label: "node",
    status: "ok",
  },
  {
    detail: "DATABASE_URL is not set",
    label: "postgres",
    status: "warn",
  },
  {
    detail: "connection refused",
    label: "migrations",
    status: "fail",
  },
];

describe("renderDoctor", () => {
  test("renders unicode status tokens", () => {
    expect(renderDoctor(checks, { ascii: false, color: "never", isTty: false })).toContain(
      "postgres    ⚠ DATABASE_URL is not set",
    );
  });

  test("renders ascii status tokens", () => {
    expect(renderDoctor(checks, { ascii: true, color: "never", isTty: false })).toContain(
      "migrations  [fail] connection refused",
    );
  });
});
