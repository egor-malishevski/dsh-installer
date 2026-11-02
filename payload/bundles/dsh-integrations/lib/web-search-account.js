// web_search through the DeepSeek Account sign-in for every session, whatever its model provider.
// Reuses the packaged DeepSeekSearchProvider and drops only its "session must be on
// the deepseek-account route" gate. host-deps.js already pins the packaged version (0.2.1-rc.5).
import { hostImport } from './host-deps.js';

const mod = await hostImport('@deepseek-ai/dsh-web-search-deepseek');
if (typeof mod.DeepSeekSearchProvider !== 'function') throw new Error('web-search-account: packaged DeepSeekSearchProvider not found');

export const name = 'web-search-account';
export const inject = ['web'];
export const PROVIDER_ID = 'deepseek-account-search';

export function apply(ctx) {
  const provider = new mod.DeepSeekSearchProvider(() => ({
    resolveAccountToken: endpoint => ctx.get('deepseekAccount')?.resolveToken(endpoint),
    resolveApiKey: async () => undefined,
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseURL: mod.DEEPSEEK_DEFAULT_BASE_URL,
    model: mod.DEEPSEEK_DEFAULT_MODEL,
    apiVersion: mod.DEEPSEEK_DEFAULT_API_VERSION,
    maxTokens: mod.DEEPSEEK_DEFAULT_MAX_TOKENS,
    maxUses: mod.DEEPSEEK_DEFAULT_MAX_USES,
    recordRequest: request => {
      ctx.get('agents')?.currentInitiator()?.session.append('web/deepseek-search-llm-request', request);
    },
  }));
  provider.id = PROVIDER_ID;
  ctx.web.registerSearchProvider(provider);
}
