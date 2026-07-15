export type ServiceName = 'web' | 'core' | 'workers';

export interface HealthStatus {
  status: 'ok';
  service: ServiceName;
  version: string; // e.g. "0.1.0"
  timestamp: string; // ISO 8601, new Date().toISOString()
}
