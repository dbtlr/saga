#!/usr/bin/env node

const names = process.argv.slice(2);
const missing = names.filter(
  (name) => process.env[name]?.trim() === undefined || process.env[name]?.trim() === "",
);

if (names.length === 0) {
  console.error("usage: require-env <NAME> [NAME...]");
  process.exitCode = 2;
} else if (missing.length > 0) {
  console.error(
    `missing required environment variable${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
  );
  process.exitCode = 1;
}
