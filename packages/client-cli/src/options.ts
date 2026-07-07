export type OutputFormat = 'records' | 'json' | 'jsonl' | 'ids';
export type ColorMode = 'auto' | 'always' | 'never';

export type GlobalOptions = {
  ascii: boolean;
  color: ColorMode;
  format: OutputFormat;
  help: boolean;
  version: boolean;
};
