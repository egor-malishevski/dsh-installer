import type { WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import type { ProviderAdapter } from '../types.ts'

export class TavilyAdapter implements ProviderAdapter {
  readonly id = 'tavily'
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
    if (!apiKey) throw new Error('Tavily API key is missing')

    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: maxResults,
        include_answer: true,
      }),
      signal,
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw new Error(`Tavily search failed (${response.status}): ${errText || response.statusText}`)
    }

    const data = await response.json() as {
      answer?: string
      results?: Array<{
        title?: string
        url: string
        content?: string
        published_date?: string
      }>
    }

    const sources: WebSearchSource[] = (data.results ?? [])
      .filter((r): r is { url: string; [k: string]: unknown } => typeof r?.url === 'string' && r.url.trim().length > 0)
      .map((r) => ({
        url: r.url.trim(),
        ...(typeof r.title === 'string' && r.title.trim().length > 0 ? { title: r.title.trim() } : {}),
        ...(typeof r.content === 'string' && r.content.trim().length > 0 ? { snippet: r.content.trim() } : {}),
        ...(typeof r.published_date === 'string' && r.published_date.trim().length > 0 ? { publishedAt: r.published_date.trim() } : {}),
      }))

    return {
      ...(typeof data.answer === 'string' && data.answer.trim().length > 0 ? { content: data.answer.trim() } : {}),
      sources,
      truncated: false,
    }
  }
}
