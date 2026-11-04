import type { WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import type { ProviderAdapter } from '../types.ts'

export class BochaAdapter implements ProviderAdapter {
  readonly id = 'bocha'
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
    if (!apiKey) throw new Error('Bocha API key is missing')

    const response = await fetch('https://api.bochaai.com/v1/web-search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        freshness: 'noLimit',
        summary: true,
        count: maxResults,
      }),
      signal,
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw new Error(`Bocha search failed (${response.status}): ${errText || response.statusText}`)
    }

    const data = await response.json() as {
      data?: {
        webPages?: {
          value?: Array<{
            name?: string
            url: string
            snippet?: string
            summary?: string
            dateLastCrawled?: string
          }>
        }
      }
    }

    const pages = data.data?.webPages?.value ?? []
    const sources: WebSearchSource[] = pages
      .filter((r): r is { url: string; [k: string]: unknown } => typeof r?.url === 'string' && r.url.trim().length > 0)
      .map((r) => {
        const rawSnippet = typeof r.summary === 'string' && r.summary.trim().length > 0 ? r.summary : r.snippet
        return {
          url: r.url.trim(),
          ...(typeof r.name === 'string' && r.name.trim().length > 0 ? { title: r.name.trim() } : {}),
          ...(typeof rawSnippet === 'string' && rawSnippet.trim().length > 0 ? { snippet: rawSnippet.trim() } : {}),
          ...(typeof r.dateLastCrawled === 'string' && r.dateLastCrawled.trim().length > 0 ? { publishedAt: r.dateLastCrawled.trim() } : {}),
        }
      })

    return {
      sources,
      truncated: false,
    }
  }
}
