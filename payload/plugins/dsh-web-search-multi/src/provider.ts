import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { MultiSearchConfig, ProviderAdapter, SearchProviderKind } from './types.ts'
import { So360Adapter } from './adapters/so360.ts'
import { BingAdapter } from './adapters/bing.ts'
import { BaiduAdapter } from './adapters/baidu.ts'
import { TavilyAdapter } from './adapters/tavily.ts'
import { BraveAdapter } from './adapters/brave.ts'
import { SerperAdapter } from './adapters/serper.ts'
import { BochaAdapter } from './adapters/bocha.ts'
import { SearxngAdapter } from './adapters/searxng.ts'
import { DuckDuckGoAdapter } from './adapters/duckduckgo.ts'

export const MULTI_SEARCH_PROVIDER_ID = 'multi-search'

export class MultiSearchProvider implements WebSearchProvider {
  readonly id = MULTI_SEARCH_PROVIDER_ID

  private readonly adapters: Map<SearchProviderKind, ProviderAdapter> = new Map()
  private readonly configProvider: () => MultiSearchConfig
  private readonly resolveCredential: (ref: string) => Promise<string | undefined> | string | undefined
  private readonly resolveEnv: (key: string) => string | undefined

  constructor(
    configOrProvider: MultiSearchConfig | (() => MultiSearchConfig),
    resolveCredential: (ref: string) => Promise<string | undefined> | string | undefined,
    resolveEnv?: (key: string) => string | undefined,
  ) {
    this.configProvider = typeof configOrProvider === 'function' ? configOrProvider : () => configOrProvider
    this.resolveCredential = resolveCredential
    this.resolveEnv = resolveEnv || ((k) => (typeof process !== 'undefined' ? process.env[k] : undefined))

    // Register all supported adapters
    this.adapters.set('so360', new So360Adapter())
    this.adapters.set('bing', new BingAdapter())
    this.adapters.set('baidu', new BaiduAdapter())
    this.adapters.set(
      'tavily',
      new TavilyAdapter(async () => {
        const ref = this.configProvider().tavilyApiKeyEnv || 'TAVILY_API_KEY'
        return (await this.resolveCredential(ref)) || this.resolveEnv('TAVILY_API_KEY')
      }),
    )
    this.adapters.set(
      'brave',
      new BraveAdapter(async () => {
        const ref = this.configProvider().braveApiKeyEnv || 'BRAVE_API_KEY'
        return (await this.resolveCredential(ref)) || this.resolveEnv('BRAVE_API_KEY')
      }),
    )
    this.adapters.set(
      'serper',
      new SerperAdapter(async () => {
        const ref = this.configProvider().serperApiKeyEnv || 'SERPER_API_KEY'
        return (await this.resolveCredential(ref)) || this.resolveEnv('SERPER_API_KEY')
      }),
    )
    this.adapters.set(
      'bocha',
      new BochaAdapter(async () => {
        const ref = this.configProvider().bochaApiKeyEnv || 'BOCHA_API_KEY'
        return (await this.resolveCredential(ref)) || this.resolveEnv('BOCHA_API_KEY')
      }),
    )
    this.adapters.set(
      'searxng',
      new SearxngAdapter(
        () => this.configProvider().searxngUrl || this.resolveEnv('SEARXNG_URL'),
        async () => {
          const ref = this.configProvider().searxngTokenEnv || 'SEARXNG_TOKEN'
          return (await this.resolveCredential(ref)) || this.resolveEnv('SEARXNG_TOKEN')
        },
      ),
    )
    this.adapters.set('duckduckgo', new DuckDuckGoAdapter())
  }

  available(): boolean {
    return true
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // Sanitize query to remove outer quotes or broken phrase matching
    const rawQuery = request.query || ''
    const cleanQuery = rawQuery.replace(/^[\"'“”‘’\s]+|[\"'“”‘’\s]+$/g, '').replace(/[\"'“”‘’]/g, ' ').replace(/\s+/g, ' ').trim()

    const config = this.configProvider()
    const specified = config.provider ?? 'auto'
    const maxResults = request.maxResults ?? 8
    const enableFallback = config.enableFallback !== false

    const candidates: ProviderAdapter[] = []

    if (specified !== 'auto') {
      const selected = this.adapters.get(specified)
      if (selected && (await selected.isAvailable())) {
        candidates.push(selected)
      }
    }

    // Build the fallback chain: Prioritize API keys, then 360, then Bing, then Baidu, then SearXNG, then DDG
    const priorityOrder: SearchProviderKind[] = [
      'tavily',
      'brave',
      'serper',
      'bocha',
      'so360',
      'bing',
      'baidu',
      'searxng',
      'duckduckgo',
    ]

    for (const kind of priorityOrder) {
      if (kind === specified) continue
      const adapter = this.adapters.get(kind)
      if (adapter && (await adapter.isAvailable())) {
        candidates.push(adapter)
      }
    }

    if (candidates.length === 0) {
      throw new Error('No web search providers are currently available or configured.')
    }

    const errors: Array<{ provider: string; error: unknown }> = []

    for (const adapter of candidates) {
      if (signal?.aborted) {
        throw new Error('Web search aborted by caller')
      }

      try {
        const rawResult = await adapter.search(cleanQuery, maxResults, signal)
        const sources: WebSearchSource[] = (rawResult.sources ?? [])
          .filter((s): s is WebSearchSource => Boolean(s && typeof s.url === 'string' && s.url.trim().length > 0))
          .map((s) => ({
            url: s.url.trim(),
            ...(typeof s.title === 'string' && s.title.trim().length > 0 ? { title: s.title.trim() } : {}),
            ...(typeof s.snippet === 'string' && s.snippet.trim().length > 0 ? { snippet: s.snippet.trim() } : {}),
            ...(typeof s.publishedAt === 'string' && s.publishedAt.trim().length > 0 ? { publishedAt: s.publishedAt.trim() } : {}),
          }))

        const content = typeof rawResult.content === 'string' && rawResult.content.trim().length > 0
          ? rawResult.content.trim()
          : undefined

        if (sources.length > 0 || content !== undefined) {
          return {
            ...(content !== undefined ? { content } : {}),
            sources,
            truncated: Boolean(rawResult.truncated),
          }
        }
      } catch (err) {
        errors.push({ provider: adapter.id, error: err })
        if (!enableFallback) {
          throw err
        }
        // Continue to next available provider in fallback chain
      }
    }

    // If all failed
    const errorDetails = errors
      .map((e) => `[${e.provider}]: ${e.error instanceof Error ? e.error.message : String(e.error)}`)
      .join('; ')

    throw new Error(`All web search providers failed. Details: ${errorDetails}`)
  }
}
