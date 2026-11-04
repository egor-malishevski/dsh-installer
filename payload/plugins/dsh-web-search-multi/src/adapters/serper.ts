import type { WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import type { ProviderAdapter } from '../types.ts'

export class SerperAdapter implements ProviderAdapter {
  readonly id = 'serper'
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
    if (!apiKey) throw new Error('Serper API key is missing')

    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': apiKey,
      },
      body: JSON.stringify({
        q: query,
        num: maxResults,
      }),
      signal,
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw new Error(`Serper search failed (${response.status}): ${errText || response.statusText}`)
    }

    const data = await response.json() as {
      answerBox?: { answer?: string; snippet?: string; title?: string }
      organic?: Array<{
        title?: string
        link: string
        snippet?: string
        date?: string
      }>
    }

    const rawAnswer = data.answerBox?.answer ?? data.answerBox?.snippet
    const content = typeof rawAnswer === 'string' && rawAnswer.trim().length > 0 ? rawAnswer.trim() : undefined

    const sources: WebSearchSource[] = (data.organic ?? [])
      .filter((r): r is { link: string; [k: string]: unknown } => typeof r?.link === 'string' && r.link.trim().length > 0)
      .map((r) => ({
        url: r.link.trim(),
        ...(typeof r.title === 'string' && r.title.trim().length > 0 ? { title: r.title.trim() } : {}),
        ...(typeof r.snippet === 'string' && r.snippet.trim().length > 0 ? { snippet: r.snippet.trim() } : {}),
        ...(typeof r.date === 'string' && r.date.trim().length > 0 ? { publishedAt: r.date.trim() } : {}),
      }))

    return {
      ...(content !== undefined ? { content } : {}),
      sources,
      truncated: false,
    }
  }
}
