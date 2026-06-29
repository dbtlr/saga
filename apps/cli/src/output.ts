import type { OutputFormat } from './cli.js';

export type CommandOutput = {
  id?: string | undefined;
  records: string;
  value: unknown;
};

export function formatCommandOutput(output: CommandOutput, format: OutputFormat): string {
  if (format === 'records') {
    return output.records;
  }
  if (format === 'json') {
    return JSON.stringify(output.value, null, 2);
  }
  if (format === 'jsonl') {
    return `${JSON.stringify(output.value)}\n`;
  }
  return output.id ?? '';
}
