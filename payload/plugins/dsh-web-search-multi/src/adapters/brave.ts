import type { WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import type { ProviderAdapter } from '../types.ts'

export class BraveAdapter implements ProviderAdapter {
  readonly id = 'brave'
  private readonly apiKeyProvider: () => Promise<string | undefined> | string | undefined

  constructor(apiKeyProvider: () => Promise<string | undefined> | string | undefined) {
    this.apiKeyProvider = apiKeyProvider
  }

  async isAvailable(): Promise<boolean> {
    const key = await this.apiKeyProvider()
    return Boolean(key && key.trim().length > 0)
  }

  async search(query: string, maxResults: number, signal?: AbortSignal): Promise<WebSearchResult> {
    const apiKey = await this.apiKeyProvider()
    if (!apiKey) throw new Error('Brave API key is missing')

    const url = new URL('https://api.search.brave.com/res/v1/web/search')
    url.searchParams.set('q', query)
    url.searchParams.set('count', String(Math.min(maxResults, 20)))

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': apiKey,
      },
      signal,
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw new Error(`Brave search failed (${response.status}): ${errText || response.statusText}`)
    }

    const data = await response.json() as {
      web?: {
        results?: Array<{
          title?: string
          url: string
          description?: string
          page_age?: string
        }>
      }
    }

    const sources: WebSearchSource[] = (data.web?.results ?? [])
      .filter((r): r is { url: string; [k: string]: unknown } => typeof r?.url === 'string' && r.url.trim().length > 0)
      .map((r) => ({
        url: r.url.trim(),
        ...(typeof r.title === 'string' && r.title.trim().length > 0 ? { title: r.title.trim() } : {}),
        ...(typeof r.description === 'string' && r.description.trim().length > 0 ? { snippet: r.description.trim() } : {}),
        ...(typeof r.page_age === 'string' && r.page_age.trim().length > 0 ? { publishedAt: r.page_age.trim() } : {}),
      }))

    return {
      sources,
      truncated: false,
    }
  }
}
