export function buildPostgresScenarioMetrics(input) {
  const directPgMs = samples(input.directPgMs, 'directPgMs');
  const durableReferenceMs = pairedSamples(
    directPgMs,
    input.durableReferenceMs,
    'durableReferenceMs',
  );
  const schemanautEndToEndMs = pairedSamples(
    directPgMs,
    input.schemanautEndToEndMs,
    'schemanautEndToEndMs',
  );
  const threshold = positiveNumber(
    input.platformOverheadP95ThresholdMs,
    'platformOverheadP95ThresholdMs',
  );
  const durableReferenceDeltaSamples = schemanautEndToEndMs.map(
    (value, index) => round(value - durableReferenceMs[index]),
  );
  const platformOverheadSamples = pairedSamples(
    directPgMs,
    input.exactPlatformOverheadMs,
    'exactPlatformOverheadMs',
  );
  const durabilityOverheadSamples = durableReferenceMs.map(
    (value, index) => round(value - directPgMs[index]),
  );
  const phases = summarizePhases(directPgMs, input.schemanautPhasesMs, 'schemanautPhasesMs');
  const durableReferencePhases = summarizePhases(
    directPgMs,
    input.durableReferencePhasesMs,
    'durableReferencePhasesMs',
  );
  const platformOverhead = {
    ...summarizeSigned(platformOverheadSamples),
    rawSamplesMs: platformOverheadSamples,
  };
  const durabilityOverhead = {
    ...summarizeSigned(durabilityOverheadSamples),
    rawSamplesMs: durabilityOverheadSamples,
  };
  const durableReferenceDelta = {
    ...summarizeSigned(durableReferenceDeltaSamples),
    rawSamplesMs: durableReferenceDeltaSamples,
  };
  return {
    directPg: summarize(directPgMs),
    durableReference: summarize(durableReferenceMs),
    schemanaut: summarize(schemanautEndToEndMs),
    platformOverhead,
    durabilityOverhead,
    durableReferenceDelta,
    phases,
    durableReferencePhases,
    platformOverheadP95Ms: platformOverhead.p95Ms,
    platformOverheadP95ThresholdMs: threshold,
    rawSamples: {
      directPgMs,
      durableReferenceMs,
      schemanautMs: schemanautEndToEndMs,
      platformOverheadMs: platformOverheadSamples,
      durableReferenceDeltaMs: durableReferenceDeltaSamples,
      durabilityOverheadMs: durabilityOverheadSamples,
    },
    passed: platformOverhead.p95Ms <= threshold,
  };
}

export function averageDurableMeasurements(first, second) {
  if (first.result.rowCount !== second.result.rowCount) {
    throw new Error('Mirrored durable measurements returned different row counts.');
  }
  if (first.result.pageCount !== second.result.pageCount) {
    throw new Error('Mirrored durable measurements returned different page counts.');
  }
  const phaseNames = Object.keys(first.result.phases);
  if (phaseNames.length !== Object.keys(second.result.phases).length ||
      phaseNames.some((name) => second.result.phases[name] === undefined)) {
    throw new Error('Mirrored durable measurements returned different phases.');
  }
  return {
    durationMs: average(first.durationMs, second.durationMs),
    result: {
      ...first.result,
      phases: Object.fromEntries(phaseNames.map((name) => [
        name,
        average(first.result.phases[name], second.result.phases[name]),
      ])),
    },
  };
}

function summarizePhases(reference, phaseInput, inputName) {
  return Object.fromEntries(
    Object.entries(phaseInput ?? {}).map(([name, values]) => {
      const phase = pairedSamples(reference, values, `${inputName}.${name}`);
      return [name, { ...summarize(phase), rawSamplesMs: phase }];
    }),
  );
}

export async function readCompleteResultPages({
  handleId,
  readPage,
  pageLimit = 1_000,
}) {
  if (typeof handleId !== 'string' || handleId.length === 0) {
    throw new Error('A result handle is required.');
  }
  if (typeof readPage !== 'function') throw new Error('A result page reader is required.');
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 1_000) {
    throw new Error('pageLimit must be an integer between 1 and 1000.');
  }
  const rows = [];
  const seenCursors = new Set();
  let cursor;
  let pageCount = 0;
  let byteCount = 0;
  while (true) {
    const page = await readPage({
      ...(cursor === undefined ? {} : { cursor }),
      limit: pageLimit,
    });
    if (page.handleId !== handleId) throw new Error('Result page belongs to another handle.');
    if (page.rowOffset !== rows.length) throw new Error('Result page row offset is not contiguous.');
    rows.push(...page.rows);
    pageCount += 1;
    byteCount += page.byteCount;
    if (page.complete) break;
    if (!page.nextCursor || seenCursors.has(page.nextCursor)) {
      throw new Error('Incomplete result page did not provide a new next cursor.');
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  return { rows, rowCount: rows.length, pageCount, byteCount };
}

export function summarize(samplesInput) {
  const values = samples(samplesInput, 'samples');
  return summarizeValues(values);
}

function summarizeSigned(samplesInput) {
  const values = numericSamples(samplesInput, 'samples');
  return summarizeValues(values);
}

function summarizeValues(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    maxMs: round(sorted.at(-1)),
    minMs: round(sorted[0]),
  };
}

function pairedSamples(reference, values, name) {
  const normalized = samples(values, name);
  if (normalized.length !== reference.length) {
    throw new Error(`${name} must contain ${reference.length} paired samples.`);
  }
  return normalized;
}

function samples(values, name) {
  return numericSamples(values, name, false);
}

function numericSamples(values, name, allowNegative = true) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${name} must contain at least one sample.`);
  }
  return values.map((value) => {
    if (!Number.isFinite(value) || (!allowNegative && value < 0)) {
      throw new Error(`${name} contains an invalid sample.`);
    }
    return round(value);
  });
}

function positiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive.`);
  return value;
}

function percentile(values, ratio) {
  const rank = Math.max(0, Math.ceil(values.length * ratio) - 1);
  return values[Math.min(rank, values.length - 1)];
}

function round(value) {
  return Number(value.toFixed(3));
}

function average(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    throw new Error('Mirrored measurements must be finite.');
  }
  return round((left + right) / 2);
}
