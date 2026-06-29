import { describe, expect, it } from 'vitest';

import {
  countLine,
  errorLine,
  glyph,
  noteLine,
  recordBlock,
  separator,
  severityLine,
  shouldColor,
} from './render.js';

const plain = { ascii: false, color: 'never' as const, format: 'records' as const, isTty: true };
const ascii = { ascii: true, color: 'always' as const, format: 'records' as const, isTty: true };

describe('render primitives', () => {
  it('keeps color disabled when requested', () => {
    expect(shouldColor(plain)).toBe(false);
    expect(glyph('success', plain)).toBe('✓');
  });

  it('uses ascii fallbacks', () => {
    expect(glyph('error', ascii)).toBe('[err]');
    expect(separator(ascii, 4)).toBe('----');
  });

  it('renders common line primitives', () => {
    expect(countLine(2, 'workspace', plain)).toBe('2 workspaces');
    expect(noteLine('note', 'check service status', plain)).toBe('note: check service status');
    expect(severityLine('warning', 3, 'warnings', plain)).toBe('  ⚠   3 warnings');
    expect(errorLine('unknown command', plain)).toBe('✗ unknown command');
  });

  it('renders record blocks with aligned labels', () => {
    expect(
      recordBlock(
        'SGA',
        [
          { label: 'status', value: 'ready' },
          { label: 'workspace', value: 'saga' },
        ],
        plain,
      ),
    ).toBe(['SGA', '  status     ready', '  workspace  saga'].join('\n'));
  });
});
