import { metrics, type Histogram, type MeterProvider, type UpDownCounter } from '@opentelemetry/api';

export const GRAPH_QUERY_DURATION_METRIC = 'graph_query_duration_ms';
export const GRAPH_QUERY_CONCURRENT_METRIC = 'graph_query_concurrent_count';
export const GRAPH_QUERY_RESULT_NODE_COUNT_METRIC = 'graph_query_result_node_count';

interface Instruments {
  duration: Histogram;
  concurrent: UpDownCounter;
  resultNodeCount: Histogram;
}

let cachedProvider: MeterProvider | null = null;
let cachedInstruments: Instruments | null = null;

function instruments(): Instruments {
  const provider = metrics.getMeterProvider();
  if (cachedInstruments === null || cachedProvider !== provider) {
    const meter = provider.getMeter('sayre.core.graph');
    cachedInstruments = {
      duration: meter.createHistogram(GRAPH_QUERY_DURATION_METRIC),
      concurrent: meter.createUpDownCounter(GRAPH_QUERY_CONCURRENT_METRIC),
      resultNodeCount: meter.createHistogram(GRAPH_QUERY_RESULT_NODE_COUNT_METRIC),
    };
    cachedProvider = provider;
  }
  return cachedInstruments;
}

export interface GraphWriteMeasurement {
  setResultNodeCount(count: number): void;
}

export async function instrumentGraphWrite<T>(
  orgId: string,
  operation: (measurement: GraphWriteMeasurement) => Promise<T>,
): Promise<T> {
  if (orgId.trim().length === 0) {
    throw new Error('Graph writes require a non-blank server-derived org id.');
  }

  const meter = instruments();
  const attributes = { org_id: orgId, query_shape: 'write' };
  let resultNodeCount: number | null = null;
  const measurement: GraphWriteMeasurement = {
    setResultNodeCount(count) {
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new RangeError('Graph result node count must be a non-negative safe integer.');
      }
      resultNodeCount = count;
    },
  };

  meter.concurrent.add(1, attributes);
  const started = performance.now();
  try {
    return await operation(measurement);
  } finally {
    meter.duration.record(performance.now() - started, attributes);
    if (resultNodeCount !== null) meter.resultNodeCount.record(resultNodeCount, attributes);
    meter.concurrent.add(-1, attributes);
  }
}

export function resetGraphMetricsForTests(): void {
  cachedProvider = null;
  cachedInstruments = null;
}
