import type { ColorMode, GlobalOptions, OutputFormat } from './cli.js';

export interface RenderOptions {
  ascii: boolean;
  color: ColorMode;
  format: OutputFormat;
  isTty: boolean;
}

export type Severity = 'success' | 'warning' | 'error';

export interface FieldRow {
  label: string;
  value: string;
}

const ANSI = {
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  reset: '\u001b[0m',
  amber: '\u001b[33m',
  moss: '\u001b[32m',
  rune: '\u001b[31m',
  thread: '\u001b[36m',
};

const GLYPHS: Record<Severity, { unicode: string; ascii: string }> = {
  success: { unicode: '✓', ascii: '[ok]' },
  warning: { unicode: '⚠', ascii: '[warn]' },
  error: { unicode: '✗', ascii: '[err]' },
};

const SEVERITY_COLOR: Record<Severity, keyof typeof ANSI> = {
  success: 'moss',
  warning: 'amber',
  error: 'rune',
};

export function renderOptionsFromGlobals(
  options: GlobalOptions,
  isTty = process.stdout.isTTY === true,
): RenderOptions {
  return {
    ascii: options.ascii,
    color: options.color,
    format: options.format,
    isTty,
  };
}

export function shouldColor(options: RenderOptions): boolean {
  if (options.ascii) return false;
  if (options.color === 'always') return true;
  if (options.color === 'never') return false;
  return options.isTty && process.env.NO_COLOR === undefined;
}

export function style(text: string, token: keyof typeof ANSI, options: RenderOptions): string {
  if (!shouldColor(options)) return text;
  return `${ANSI[token]}${text}${ANSI.reset}`;
}

export function glyph(severity: Severity, options: RenderOptions): string {
  const mark = options.ascii ? GLYPHS[severity].ascii : GLYPHS[severity].unicode;
  return style(mark, SEVERITY_COLOR[severity], options);
}

export function countLine(count: number, noun: string, options: RenderOptions): string {
  const unit = count === 1 ? noun : `${noun}s`;
  return style(`${String(count)} ${unit}`, 'dim', options);
}

export function noteLine(kind: 'note' | 'tip', message: string, options: RenderOptions): string {
  return `${style(`${kind}:`, 'thread', options)} ${style(message, 'dim', options)}`;
}

export function severityLine(
  severity: Severity,
  count: number,
  label: string,
  options: RenderOptions,
): string {
  return `  ${glyph(severity, options)} ${String(count).padStart(3)} ${label}`;
}

export function separator(options: RenderOptions, width = 46): string {
  const char = options.ascii ? '-' : '─';
  return style(char.repeat(Math.min(width, 60)), 'dim', options);
}

export function recordBlock(
  title: string,
  fields: readonly FieldRow[],
  options: RenderOptions,
): string {
  const labelWidth = fields.reduce((width, field) => Math.max(width, field.label.length), 0) + 2;
  const rows = fields.map(
    (field) => `  ${style(field.label.padEnd(labelWidth), 'dim', options)}${field.value}`,
  );
  return [style(title, 'bold', options), ...rows].join('\n');
}

export function errorLine(message: string, options: RenderOptions): string {
  return `${glyph('error', options)} ${message}`;
}
