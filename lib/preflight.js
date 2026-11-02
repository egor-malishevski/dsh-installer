import { inspectEnvironment } from './environment.js';

// The transaction performs the authoritative clean-profile and process checks.
export async function preflight(options = {}) {
  return inspectEnvironment(options);
}
