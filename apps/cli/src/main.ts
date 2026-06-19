import { run } from "./cli.js";

const exitCode = run(process.argv.slice(2), (text) => {
  process.stdout.write(`${text}\n`);
});

process.exitCode = exitCode;
