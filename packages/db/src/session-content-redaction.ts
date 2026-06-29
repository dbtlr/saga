type JsonRecord = Record<string, unknown>;

const SKIPPED_SEGMENT_KINDS = new Set(['tool_group_skipped', 'turn_skipped']);

export type SkippedContentSegment = {
  metadata: unknown;
  segmentKind: string | null;
};

export function safeContentPartsForSkippedSegments(
  contentParts: unknown[],
  segments: readonly SkippedContentSegment[],
): unknown[] {
  const summary = summarizeSkippedSegments(segments);
  if (summary === undefined) {
    return contentParts;
  }

  return [
    {
      type: 'omitted',
      text: '[content omitted: skipped turn payload]',
      omitted: true,
      reason: 'skipped_segment_payload',
      filterReasons: summary.filterReasons,
      skippedPartCount: summary.skippedPartCount,
      skippedSegmentCount: summary.skippedSegmentCount,
      segmentKinds: summary.segmentKinds,
    },
  ];
}

function summarizeSkippedSegments(segments: readonly SkippedContentSegment[]):
  | {
      filterReasons: string[];
      skippedPartCount: number;
      skippedSegmentCount: number;
      segmentKinds: string[];
    }
  | undefined {
  const filterReasons = new Set<string>();
  const segmentKinds = new Set<string>();
  let skippedPartCount = 0;
  let skippedSegmentCount = 0;

  for (const segment of segments) {
    const metadata = asRecord(segment.metadata);
    if (!hasSkippedObservability(segment, metadata)) {
      continue;
    }

    skippedSegmentCount += 1;
    if (segment.segmentKind !== null) {
      segmentKinds.add(segment.segmentKind);
    }

    for (const reason of readFilterReasons(metadata)) {
      filterReasons.add(reason);
    }
    skippedPartCount += readSkippedPartCount(metadata);
  }

  if (skippedSegmentCount === 0) {
    return undefined;
  }

  return {
    filterReasons: [...filterReasons].toSorted(),
    skippedPartCount,
    skippedSegmentCount,
    segmentKinds: [...segmentKinds].toSorted(),
  };
}

function hasSkippedObservability(segment: SkippedContentSegment, metadata: JsonRecord): boolean {
  return (
    (segment.segmentKind !== null && SKIPPED_SEGMENT_KINDS.has(segment.segmentKind)) ||
    metadata.segmentStatus === 'skipped' ||
    metadata.omittedSearchText === true ||
    readSkippedPartCount(metadata) > 0 ||
    readFilterReasons(metadata).length > 0
  );
}

function readFilterReasons(metadata: JsonRecord): string[] {
  const reasons: string[] = [];
  appendStringArray(reasons, metadata.filterReasons);
  appendFilterReasons(reasons, metadata.filters);

  const toolGroup = asRecord(metadata.toolGroup);
  appendStringArray(reasons, toolGroup.filterReasons);
  appendFilterReasons(reasons, toolGroup.filters);

  return reasons;
}

function appendStringArray(target: string[], value: unknown): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0) {
      target.push(entry);
    }
  }
}

function appendFilterReasons(target: string[], value: unknown): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const entry of value) {
    const reason = asRecord(entry).reason;
    if (typeof reason === 'string' && reason.length > 0) {
      target.push(reason);
    }
  }
}

function readSkippedPartCount(metadata: JsonRecord): number {
  const topLevelCount = readNonNegativeNumber(metadata.skippedPartCount);
  if (topLevelCount > 0) {
    return topLevelCount;
  }

  return readNonNegativeNumber(asRecord(metadata.toolGroup).skippedPartCount);
}

function readNonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function asRecord(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : {};
}
