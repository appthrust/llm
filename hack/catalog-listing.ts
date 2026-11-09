// Catalog listing: the publisher-authored presentation of this app (localized
// copy, highlights, digest-pinned screenshots). Authored in catalog/listing.yaml
// with screenshot files under catalog/screenshots/, uploaded to the Cloud
// catalog media store, and submitted inside the catalog entry. The platform
// projects it onto ApplicationStackDefinition.spec.display and the Dashboard
// renders it on the Marketplace card and detail page.
//
// Bounds mirror the platform contract (pkg/appcatalog.ValidateListing):
// locales ≤ 16 with "en" required; tagline ≤ 200, title ≤ 100, overview ≤ 4000,
// notes ≤ 2000 per version (≤ 32 versions); highlights ≤ 6 (title ≤ 80,
// body ≤ 400); screenshots ≤ 8, each ≤ 512 KiB image/webp or image/png with
// alt ≤ 300 per locale.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { YAML } from 'bun'

export const FALLBACK_LOCALE = 'en'
export const MAX_MEDIA_SIZE = 512 * 1024

export interface ListingLocale {
  title?: string
  tagline: string
  overview?: string
  notes?: Record<string, string>
}

export interface ListingHighlight {
  locales: Record<string, { title: string; body?: string }>
  screenshot?: string
}

export interface ListingMedia {
  name: string
  digest: string
  mediaType: 'image/webp' | 'image/png'
  size: number
  width: number
  height: number
  alt: Record<string, string>
}

export interface Listing {
  locales: Record<string, ListingLocale>
  highlights?: ListingHighlight[]
  screenshots?: ListingMedia[]
}

/** catalog/listing.yaml: screenshots name a file instead of a digest. */
interface ListingSource {
  locales: Record<string, ListingLocale>
  highlights?: ListingHighlight[]
  screenshots?: Array<{ name: string; file: string; alt: Record<string, string> }>
}

export interface MediaBlob extends ListingMedia {
  bytes: Uint8Array
}

const localeTag = /^[a-z]{2,3}$/
const dnsLabel = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
const versionName = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

function bound(value: string | undefined, max: number, what: string): void {
  if (value !== undefined && value.length > max) throw new Error(`${what} exceeds ${max} characters`)
}

function localizedText(text: Record<string, string> | undefined, max: number, what: string): void {
  if (!text || typeof text !== 'object') throw new Error(`${what} must map locales to text`)
  if (!(FALLBACK_LOCALE in text)) throw new Error(`${what} requires the "${FALLBACK_LOCALE}" locale`)
  if (Object.keys(text).length > 16) throw new Error(`${what} has more than 16 locales`)
  for (const [tag, value] of Object.entries(text)) {
    if (!localeTag.test(tag)) throw new Error(`${what} locale "${tag}" must be a BCP 47 primary tag`)
    if (!value || value.length > max) throw new Error(`${what} locale "${tag}" must be 1-${max} characters`)
  }
}

export function validateListing(listing: Listing): void {
  if (!listing.locales || typeof listing.locales !== 'object') throw new Error('listing.locales is required')
  if (!(FALLBACK_LOCALE in listing.locales)) throw new Error(`listing requires the "${FALLBACK_LOCALE}" locale`)
  if (Object.keys(listing.locales).length > 16) throw new Error('listing has more than 16 locales')
  for (const [tag, locale] of Object.entries(listing.locales)) {
    if (!localeTag.test(tag)) throw new Error(`listing locale "${tag}" must be a BCP 47 primary tag`)
    if (typeof locale.tagline !== 'string' || !locale.tagline) throw new Error(`listing locale "${tag}" requires a tagline`)
    bound(locale.title, 100, `locale ${tag} title`)
    bound(locale.tagline, 200, `locale ${tag} tagline`)
    bound(locale.overview, 4000, `locale ${tag} overview`)
    const notes = locale.notes ?? {}
    if (Object.keys(notes).length > 32) throw new Error(`locale ${tag} has more than 32 version notes`)
    for (const [version, text] of Object.entries(notes)) {
      if (!versionName.test(version)) throw new Error(`locale ${tag} notes version "${version}" is invalid`)
      bound(text, 2000, `locale ${tag} notes for ${version}`)
    }
  }
  const screenshots = listing.screenshots ?? []
  if (screenshots.length > 8) throw new Error('listing has more than 8 screenshots')
  const names = new Set<string>()
  for (const media of screenshots) {
    if (!dnsLabel.test(media.name) || media.name.length > 63 || names.has(media.name)) {
      throw new Error(`screenshot name "${media.name}" is invalid or duplicated`)
    }
    names.add(media.name)
    if (!/^sha256:[a-f0-9]{64}$/.test(media.digest)) throw new Error(`screenshot ${media.name} must pin a sha256 digest`)
    if (media.mediaType !== 'image/webp' && media.mediaType !== 'image/png') {
      throw new Error(`screenshot ${media.name} has unsupported media type ${media.mediaType}`)
    }
    if (!(media.size > 0 && media.size <= MAX_MEDIA_SIZE)) throw new Error(`screenshot ${media.name} must be 1-${MAX_MEDIA_SIZE} bytes`)
    if (!(media.width > 0 && media.height > 0)) throw new Error(`screenshot ${media.name} has invalid dimensions`)
    localizedText(media.alt, 300, `screenshot ${media.name} alt`)
  }
  const highlights = listing.highlights ?? []
  if (highlights.length > 6) throw new Error('listing has more than 6 highlights')
  highlights.forEach((highlight, index) => {
    if (!highlight.locales || !(FALLBACK_LOCALE in highlight.locales)) throw new Error(`highlight ${index} requires the "${FALLBACK_LOCALE}" locale`)
    if (Object.keys(highlight.locales).length > 16) throw new Error(`highlight ${index} has more than 16 locales`)
    for (const [tag, locale] of Object.entries(highlight.locales)) {
      if (!localeTag.test(tag) || !locale.title || locale.title.length > 80 || (locale.body ?? '').length > 400) {
        throw new Error(`highlight ${index} locale "${tag}" is invalid`)
      }
    }
    if (highlight.screenshot !== undefined && !names.has(highlight.screenshot)) {
      throw new Error(`highlight ${index} references unknown screenshot "${highlight.screenshot}"`)
    }
  })
}

/** Image dimensions from the PNG IHDR or WebP VP8/VP8L/VP8X header. */
export function imageDimensions(bytes: Uint8Array): { mediaType: ListingMedia['mediaType']; width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { mediaType: 'image/png', width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (bytes.length >= 30 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') {
    const chunk = String.fromCharCode(...bytes.subarray(12, 16))
    if (chunk === 'VP8X') {
      const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16))
      const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))
      return { mediaType: 'image/webp', width, height }
    }
    if (chunk === 'VP8L') {
      const b0 = bytes[21], b1 = bytes[22], b2 = bytes[23], b3 = bytes[24]
      return { mediaType: 'image/webp', width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) }
    }
    if (chunk === 'VP8 ') {
      return { mediaType: 'image/webp', width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
    }
  }
  throw new Error('screenshot must be a PNG or WebP image')
}

/** Reads catalog/listing.yaml and its screenshot files; returns the listing with digests and the blobs to upload. */
export async function loadListing(catalogDir: URL): Promise<{ listing: Listing; media: MediaBlob[] }> {
  const source = YAML.parse(await readFile(new URL('listing.yaml', catalogDir), 'utf8')) as ListingSource
  const media: MediaBlob[] = []
  for (const shot of source.screenshots ?? []) {
    if (typeof shot.file !== 'string' || shot.file.includes('..') || shot.file.startsWith('/')) {
      throw new Error(`screenshot ${shot.name} file must be a relative path under catalog/screenshots`)
    }
    const bytes = new Uint8Array(await readFile(new URL(`screenshots/${shot.file}`, catalogDir)))
    const { mediaType, width, height } = imageDimensions(bytes)
    media.push({
      name: shot.name,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      mediaType,
      size: bytes.byteLength,
      width,
      height,
      alt: shot.alt,
      bytes,
    })
  }
  const listing: Listing = {
    locales: source.locales,
    ...(source.highlights ? { highlights: source.highlights } : {}),
    ...(media.length ? { screenshots: media.map(({ bytes: _bytes, ...descriptor }) => descriptor) } : {}),
  }
  validateListing(listing)
  return { listing, media }
}

/** Idempotent immutable uploads; the Cloud verifies the body digest against the path. */
export async function uploadMedia(
  media: MediaBlob[],
  baseURL: string,
  token: string,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<void> {
  for (const blob of media) {
    const response = await fetcher(`${baseURL}/api/v1/catalog/media/${blob.digest.slice(7)}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': blob.mediaType },
      body: blob.bytes as Uint8Array<ArrayBuffer>,
      signal: AbortSignal.timeout(60_000),
      redirect: 'error',
    })
    if (response.status !== 200) throw new Error(`PUT /catalog/media/${blob.name} failed (${response.status})`)
    const stored = await response.json() as { digest?: string; size?: number; mediaType?: string }
    if (stored.digest !== blob.digest || stored.size !== blob.size || stored.mediaType !== blob.mediaType) {
      throw new Error(`stored media ${blob.name} does not match the local file`)
    }
  }
}
