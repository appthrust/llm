import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { imageDimensions, loadListing, uploadMedia, validateListing, type Listing } from './catalog-listing'
import { renderEntry, renderListingUpdate, type CatalogEntry } from './publish-entry'

/** Minimal valid PNG: 8-byte signature + IHDR chunk; dimensions only, no pixel data. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

function webpVP8X(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30)
  bytes.set([0x52, 0x49, 0x46, 0x46], 0)
  bytes.set([0x57, 0x45, 0x42, 0x50], 8)
  bytes.set([0x56, 0x50, 0x38, 0x58], 12)
  const w = width - 1, h = height - 1
  bytes.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 24)
  bytes.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 27)
  return bytes
}

const listing: Listing = {
  locales: {
    en: { tagline: 'People, groups and profiles.', overview: 'Who is who.\n\nSearch and browse.' },
    ja: { tagline: 'この組織のメンバー、グループ、プロフィール。', overview: '誰が誰か。' },
  },
  highlights: [{ locales: { en: { title: 'Search' }, ja: { title: '検索' } }, screenshot: 'people' }],
  screenshots: [{
    name: 'people', digest: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', size: 33, width: 1280, height: 800,
    alt: { en: 'People list', ja: 'メンバー一覧' },
  }],
}

describe('imageDimensions', () => {
  test('reads PNG IHDR and WebP VP8X', () => {
    expect(imageDimensions(png(1280, 800))).toEqual({ mediaType: 'image/png', width: 1280, height: 800 })
    expect(imageDimensions(webpVP8X(1440, 900))).toEqual({ mediaType: 'image/webp', width: 1440, height: 900 })
    expect(() => imageDimensions(new Uint8Array(40))).toThrow('PNG or WebP')
  })
})

describe('validateListing', () => {
  test('accepts the sample and enforces the contract', () => {
    expect(() => validateListing(listing)).not.toThrow()
    expect(() => validateListing({ locales: { ja: { tagline: 'x' } } })).toThrow('requires the "en" locale')
    expect(() => validateListing({ ...listing, highlights: [{ locales: { en: { title: 'x' } }, screenshot: 'missing' }] }))
      .toThrow('unknown screenshot "missing"')
    expect(() => validateListing({ ...listing, screenshots: [{ ...listing.screenshots![0], size: 600_000 }] })).toThrow('bytes')
    expect(() => validateListing({ ...listing, screenshots: [{ ...listing.screenshots![0], alt: { ja: 'x' } }] })).toThrow('requires the "en" locale')
    expect(() => validateListing({ locales: { en: { tagline: 'x'.repeat(201) } } })).toThrow('exceeds 200')
  })
})

describe('loadListing', () => {
  test('resolves screenshot files to digests, sizes and dimensions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'listing-'))
    await mkdir(join(dir, 'screenshots'))
    const image = png(1200, 750)
    await writeFile(join(dir, 'screenshots', 'people.png'), image)
    await writeFile(join(dir, 'listing.yaml'), [
      'locales:', '  en: { tagline: People, groups and profiles. }', '  ja: { tagline: メンバー一覧 }',
      'highlights:', '  - screenshot: people', '    locales: { en: { title: Search }, ja: { title: 検索 } }',
      'screenshots:', '  - name: people', '    file: people.png', '    alt: { en: People list, ja: メンバー一覧 }',
    ].join('\n'))
    const { listing: loaded, media } = await loadListing(pathToFileURL(`${dir}/`))
    const digest = `sha256:${createHash('sha256').update(image).digest('hex')}`
    expect(media).toHaveLength(1)
    expect(media[0].bytes).toEqual(image)
    expect(loaded.screenshots).toEqual([{ name: 'people', digest, mediaType: 'image/png', size: 33, width: 1200, height: 750, alt: { en: 'People list', ja: 'メンバー一覧' } }])
    expect(loaded.highlights?.[0].screenshot).toBe('people')
  })

  test('rejects paths escaping catalog/screenshots', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'listing-'))
    await writeFile(join(dir, 'listing.yaml'), 'locales: { en: { tagline: x } }\nscreenshots: [{ name: a, file: ../x.png, alt: { en: a } }]\n')
    await expect(loadListing(pathToFileURL(`${dir}/`))).rejects.toThrow('relative path')
  })
})

describe('uploadMedia', () => {
  test('PUTs each blob by hex digest and checks the stored descriptor', async () => {
    const image = png(10, 10)
    const digest = `sha256:${createHash('sha256').update(image).digest('hex')}`
    const calls: Array<{ url: string; type: string }> = []
    const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, type: (init.headers as Record<string, string>)['content-type'] })
      return Response.json({ digest, mediaType: 'image/png', size: 33 })
    }
    await uploadMedia([{ ...listing.screenshots![0], digest, bytes: image }], 'https://api.example', 'token', fetcher)
    expect(calls).toEqual([{ url: `https://api.example/api/v1/catalog/media/${digest.slice(7)}`, type: 'image/png' }])
    const mismatch = async (): Promise<Response> => Response.json({ digest, mediaType: 'image/png', size: 1 })
    await expect(uploadMedia([{ ...listing.screenshots![0], digest, bytes: image }], 'https://api.example', 'token', mismatch))
      .rejects.toThrow('does not match')
  })
})

describe('listing in entries', () => {
  const template = [
    'apiVersion: appthrust.io/v1alpha1', 'kind: ApplicationStackDefinition', 'metadata: { name: llm }',
    'spec:', '  display: { title: Directory, description: People., category: collaborate, iconRef: { name: llm } }',
    '  versions: []', '  updatePolicy: { default: pinned, allowed: [pinned, follow] }',
  ].join('\n')
  const digest = `sha256:${'b'.repeat(64)}`

  test('renderEntry carries the authored listing and otherwise preserves the stored one', () => {
    const first = renderEntry(template, '0.2.0', digest, undefined, listing)
    expect(first.listing).toEqual(listing)
    const next = renderEntry(template, '0.2.1', `sha256:${'c'.repeat(64)}`, first)
    expect(next.listing).toEqual(listing)
    expect(renderEntry(template, '0.2.0', digest).listing).toBeUndefined()
  })

  test('renderListingUpdate replaces only the listing', () => {
    const current: CatalogEntry = { ...renderEntry(template, '0.2.0', digest), publishedAt: '2026-11-01T00:00:00Z' }
    const updated = renderListingUpdate(current, listing)
    expect(updated).toEqual({ ...current, listing })
    expect(() => renderListingUpdate({ ...current, slug: 'other' }, listing)).toThrow('slug llm')
  })
})
