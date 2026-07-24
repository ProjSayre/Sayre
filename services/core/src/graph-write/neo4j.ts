import neo4j, { type Driver } from 'neo4j-driver';
import { getConfig, getSecret } from '@sayre/config';
import { instrumentGraphWrite } from '../telemetry/graphMetrics';
import { assertOrgScopedCypher } from '../security/graphOrgGuard';

export interface GraphWriteRecord {
  get(key: string): unknown;
}

export interface GraphWriteResult {
  records: GraphWriteRecord[];
}

export interface GraphWriteExecutor {
  run(
    orgId: string,
    cypher: string,
    parameters: Readonly<Record<string, unknown>>,
    resultNodeCountKey?: string,
  ): Promise<GraphWriteResult>;
  close(): Promise<void>;
}

export type Neo4jDriverFactory = (
  uri: string,
  username: string,
  password: string,
) => Driver;

class InstrumentedNeo4jWriteExecutor implements GraphWriteExecutor {
  constructor(private readonly driver: Driver) {}

  async run(
    orgId: string,
    cypher: string,
    parameters: Readonly<Record<string, unknown>>,
    resultNodeCountKey?: string,
  ): Promise<GraphWriteResult> {
    return instrumentGraphWrite(orgId, async (measurement) => {
      assertOrgScopedCypher(orgId, cypher, parameters);
      const session = this.driver.session();
      try {
        const result = await session.executeWrite((transaction) =>
          transaction.run(cypher, parameters),
        );
        const resultNodeCount =
          resultNodeCountKey === undefined || result.records[0] === undefined
            ? result.records.length
            : graphIntegerToNumber(result.records[0].get(resultNodeCountKey));
        measurement.setResultNodeCount(resultNodeCount);
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

export async function createNeo4jWriteExecutor(
  factory: Neo4jDriverFactory = (uri, username, password) =>
    neo4j.driver(uri, neo4j.auth.basic(username, password)),
): Promise<GraphWriteExecutor> {
  const uri = getConfig('NEO4J_URI');
  const username = getConfig('NEO4J_USER');
  const password = await getSecret('env://NEO4J_PASSWORD');
  return new InstrumentedNeo4jWriteExecutor(factory(uri, username, password));
}

export function graphIntegerToNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (neo4j.isInt(value)) return value.toNumber();
  throw new TypeError('Expected an integer value from the graph query.');
}
