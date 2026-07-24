import neo4j, { type Driver, type Integer } from 'neo4j-driver';
import { getConfig, getSecret } from '@sayre/config';
import {
  instrumentGraphQuery,
  type GraphQueryShape,
} from '../telemetry/graphMetrics';
import { assertOrgScopedCypher } from '../security/graphOrgGuard';

// Cypher clauses like LIMIT require a genuine Integer type -- a plain JS number
// param is serialized as Float by the driver and Neo4j rejects it. This is the
// only place outside the two allowlisted executor files that may need one, so
// it's exposed here rather than importing 'neo4j-driver' directly elsewhere
// (see security/neo4jChokepoint.test.ts's import allowlist).
export function toNeo4jInt(value: number): Integer {
  return neo4j.int(value);
}

export interface GraphReadRecord {
  get(key: string): unknown;
}

export interface GraphReadResult {
  records: GraphReadRecord[];
}

export interface GraphReadExecutor {
  run(
    orgId: string,
    queryShape: Exclude<GraphQueryShape, 'write'>,
    cypher: string,
    parameters: Readonly<Record<string, unknown>>,
  ): Promise<GraphReadResult>;
  close(): Promise<void>;
}

export type Neo4jDriverFactory = (
  uri: string,
  username: string,
  password: string,
) => Driver;

class InstrumentedNeo4jReadExecutor implements GraphReadExecutor {
  constructor(private readonly driver: Driver) {}

  async run(
    orgId: string,
    queryShape: Exclude<GraphQueryShape, 'write'>,
    cypher: string,
    parameters: Readonly<Record<string, unknown>>,
  ): Promise<GraphReadResult> {
    return instrumentGraphQuery(orgId, queryShape, async (measurement) => {
      assertOrgScopedCypher(orgId, cypher, parameters);
      const session = this.driver.session();
      try {
        const result = await session.executeRead((transaction) =>
          transaction.run(cypher, parameters),
        );
        measurement.setResultNodeCount(result.records.length);
        return { records: result.records };
      } finally {
        await session.close();
      }
    });
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}

export async function createNeo4jReadExecutor(
  factory: Neo4jDriverFactory = (uri, username, password) =>
    neo4j.driver(uri, neo4j.auth.basic(username, password)),
): Promise<GraphReadExecutor> {
  const uri = getConfig('NEO4J_URI');
  const username = getConfig('NEO4J_USER');
  const password = await getSecret('env://NEO4J_PASSWORD');
  return new InstrumentedNeo4jReadExecutor(factory(uri, username, password));
}

export class LazyGraphReadExecutor implements GraphReadExecutor {
  private executorPromise: Promise<GraphReadExecutor> | undefined;

  constructor(
    private readonly factory: () => Promise<GraphReadExecutor> = createNeo4jReadExecutor,
  ) {}

  private executor(): Promise<GraphReadExecutor> {
    this.executorPromise ??= this.factory();
    return this.executorPromise;
  }

  async run(
    orgId: string,
    queryShape: Exclude<GraphQueryShape, 'write'>,
    cypher: string,
    parameters: Readonly<Record<string, unknown>>,
  ): Promise<GraphReadResult> {
    return (await this.executor()).run(orgId, queryShape, cypher, parameters);
  }

  async close(): Promise<void> {
    if (this.executorPromise) await (await this.executorPromise).close();
  }
}
