import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import { parseArgs, promisify } from 'node:util'
import { YAML } from 'bun'
import { loadListing, type Listing, type MediaBlob, uploadMedia, validateListing } from './catalog-listing'

const catalogRepository = 'ghcr.io/appthrust/catalog'
const imageRepository = 'ghcr.io/appthrust/llm'
const digestPattern = /^sha256:[a-f0-9]{64}$/
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/
const exec = promisify(execFile)

export interface CatalogVersion {
  name: string
  images: Record<string, string>
  stream: string
  minPlatformVersion?: string
  default: boolean
  served?: boolean
}

export interface CatalogEntry {
  slug: string
  definitionYAML: string
  versions: CatalogVersion[]
  updatePolicy: { default: 'pinned' | 'follow'; allowed: Array<'pinned' | 'follow'> }
  display: { category?: string; icon?: string }
  listing?: Listing
  publishedAt: string | null
}

interface Definition {
  apiVersion: string
  kind: string
  metadata: { name: string }
  spec: {
    display: { category: string; iconRef?: { name: string } }
    versions: CatalogVersion[]
    updatePolicy: CatalogEntry['updatePolicy']
  }
}

export function validateRelease(version: string, digest: string): void {
  if (version.length > 63 || !versionPattern.test(version)) {
    throw new Error('version must be SemVer without a v prefix or build metadata (at most 63 characters)')
  }
  if (!digestPattern.test(digest) || digest === `sha256:${'0'.repeat(64)}`) {
    throw new Error('digest must be a non-placeholder sha256 image index digest')
  }
}

export function renderEntry(template: string, version: string, digest: string, previous?: CatalogEntry, listing?: Listing): CatalogEntry {
  validateRelease(version, digest)
  const definition = YAML.parse(template) as Definition
  if (definition.apiVersion !== 'appthrust.io/v1alpha1' || definition.kind !== 'ApplicationStackDefinition' || definition.metadata.name !== 'llm') {
    throw new Error('template must be the llm ApplicationStackDefinition')
  }
  if (previous && previous.slug !== 'llm') throw new Error('previous entry must have slug llm')

  // Every tag starts from the committed floor. Merge the store's history so the
  // second app release cannot silently remove the first one from the catalog.
  const versions = new Map<string, CatalogVersion>()
  for (const candidate of [...definition.spec.versions, ...(previous?.versions ?? [])]) {
    const existing = versions.get(candidate.name)
    if (existing && (Object.keys(existing.images).length !== Object.keys(candidate.images).length ||
      Object.entries(existing.images).some(([slot, image]) => candidate.images[slot] !== image))) {
      throw new Error(`version ${candidate.name} already has different immutable images`)
    }
    versions.set(candidate.name, { ...candidate, images: { ...candidate.images }, default: false, served: true })
  }
  const image = `${imageRepository}@${digest}`
  const existing = versions.get(version)
  if (existing && (existing.images.web !== image || Object.keys(existing.images).length !== 1)) {
    throw new Error(`version ${version} already has different immutable images`)
  }
  versions.set(version, {
    ...existing,
    name: version,
    images: { web: image },
    stream: version.split('.').slice(0, 2).join('.'),
    served: true,
    default: true,
  })
  definition.spec.versions = [...versions.values()]
  if (listing) validateListing(listing)
  const carried = listing ?? previous?.listing
  return {
    slug: 'llm',
    definitionYAML: YAML.stringify(definition),
    versions: definition.spec.versions,
    updatePolicy: definition.spec.updatePolicy,
    display: { category: definition.spec.display.category, icon: definition.spec.display.iconRef?.name },
    ...(carried ? { listing: carried } : {}),
    publishedAt: previous?.publishedAt ?? null,
  }
}

/**
 * Replaces only the listing of the entry the catalog already records. Versions,
 * policy and display stay exactly as stored: a listing change never implies a
 * release. Requires a published entry; the first tag publish carries the
 * listing itself.
 */
export function renderListingUpdate(current: CatalogEntry, listing: Listing): CatalogEntry {
  if (current.slug !== 'llm') throw new Error('current entry must have slug llm')
  validateListing(listing)
  return { ...current, listing }
}

export function catalogContainsRelease(index: unknown, version: string, digest: string): boolean {
  if (!index || typeof index !== 'object' || !('schemaVersion' in index) || index.schemaVersion !== 1 ||
    !('entries' in index) || !Array.isArray(index.entries)) return false
  return index.entries.some(entry => entry?.slug === 'llm' && Array.isArray(entry.versions) &&
    entry.versions.some((candidate: CatalogVersion) => candidate?.name === version && candidate.images?.web === `${imageRepository}@${digest}`))
}

async function command(args: string[], deadline: number): Promise<string> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error('catalog publication deadline exceeded')
  const { stdout } = await exec(args[0]!, args.slice(1), { timeout: Math.min(30_000, remaining), maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

async function publishedRelease(version: string, digest: string, deadline: number): Promise<boolean> {
  const manifestDigest = (await command(['oras', 'resolve', `${catalogRepository}:latest`], deadline)).trim()
  if (!digestPattern.test(manifestDigest)) throw new Error('catalog manifest has an invalid digest')
  const reference = `${catalogRepository}@${manifestDigest}`
  const manifest = JSON.parse(await command(['oras', 'manifest', 'fetch', reference], deadline))
  const layer = manifest.layers?.[0]
  if (manifest.artifactType !== 'application/vnd.appthrust.app-catalog.v1+json' ||
    layer?.mediaType !== 'application/json' || layer.annotations?.['org.opencontainers.image.title'] !== 'index.json' ||
    !digestPattern.test(layer.digest)) throw new Error('catalog artifact has an invalid index layer')
  const bytes = await command(['oras', 'blob', 'fetch', '--output', '-', `${catalogRepository}@${layer.digest}`], deadline)
  if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== layer.digest) {
    throw new Error('catalog index digest mismatch')
  }
  if (!catalogContainsRelease(JSON.parse(bytes), version, digest)) return false
  // latest may move before signing completes. Only a matching, trusted artifact
  // is publication proof; never treat the dispatch response as success.
  await command(['cosign', 'verify', '--certificate-oidc-issuer', 'https://token.actions.githubusercontent.com',
    '--certificate-identity', 'https://github.com/appthrust/cloud/.github/workflows/catalog-publish.yml@refs/heads/main', reference], deadline)
  console.log(`Published llm ${version} in signed catalog ${reference}`)
  return true
}

export interface CatalogPublication {
  id: string
  state: 'queued' | 'snapshot'
}

/**
 * The image digest the catalog already records for `version`, or null. A
 * re-run of the publish workflow (for example after a failed Cloud signing
 * dispatch) must reuse this image instead of building a new one: versions are
 * immutable, so a second build with a different digest is rejected.
 */
export async function recordedDigest(
  version: string,
  baseURL: string,
  token: string,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<string | null> {
  const response = await fetcher(`${baseURL}/api/v1/catalog/entries`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  })
  if (response.status !== 200) throw new Error(`GET /catalog/entries failed (${response.status})`)
  const current = await response.json() as { data: CatalogEntry[] }
  if (!Array.isArray(current.data)) throw new Error('catalog entries response must contain data[]')
  const recorded = current.data.find(entry => entry.slug === 'llm')?.versions.find(entry => entry.name === version)
  if (!recorded) return null
  const image = recorded.images.web
  if (typeof image !== 'string' || !image.startsWith(`${imageRepository}@`) || Object.keys(recorded.images).length !== 1) {
    throw new Error(`version ${version} is recorded with an unexpected image set`)
  }
  const digest = image.slice(imageRepository.length + 1)
  if (!digestPattern.test(digest)) throw new Error(`version ${version} is recorded with an invalid digest`)
  return digest
}

interface CatalogClient {
  request(path: string, method: string, body?: unknown): Promise<Response>
  entryRequest(path: string, method: string, body?: unknown): Promise<unknown>
  currentEntry(): Promise<CatalogEntry | undefined>
  publish(): Promise<CatalogPublication>
}

function catalogClient(baseURL: string, token: string, fetcher: (url: string, init: RequestInit) => Promise<Response>): CatalogClient {
  async function request(path: string, method: string, body?: unknown): Promise<Response> {
    return fetcher(`${baseURL}/api/v1/catalog/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    })
  }
  async function entryRequest(path: string, method: string, body?: unknown): Promise<unknown> {
    const response = await request(path, method, body)
    if (response.status !== 200) throw new Error(`${method} /catalog/${path} failed (${response.status})`)
    return response.json()
  }
  return {
    request,
    entryRequest,
    async currentEntry() {
      const current = await entryRequest('entries', 'GET') as { data: CatalogEntry[] }
      if (!Array.isArray(current.data)) throw new Error('catalog entries response must contain data[]')
      return current.data.find(entry => entry.slug === 'llm')
    },
    async publish() {
      const response = await request('publish', 'POST')
      if (response.status !== 200 && response.status !== 202) throw new Error(`POST /catalog/publish failed (${response.status})`)
      const publication = await response.json() as CatalogPublication
      if (typeof publication.id !== 'string' || !publication.id || /[\r\n]/.test(publication.id) ||
        !(response.status === 202 && publication.state === 'queued' || response.status === 200 && publication.state === 'snapshot')) {
        throw new Error('catalog publish response must contain a queued (202) or snapshot (200) snapshot id')
      }
      return publication
    },
  }
}

export async function submitEntry(
  template: string,
  version: string,
  digest: string,
  baseURL: string,
  token: string,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
  listing?: { listing: Listing; media: MediaBlob[] },
): Promise<CatalogPublication> {
  validateRelease(version, digest)
  const client = catalogClient(baseURL, token, fetcher)
  const previous = await client.currentEntry()
  if (listing) await uploadMedia(listing.media, baseURL, token, fetcher)
  const entry = renderEntry(template, version, digest, previous, listing?.listing)
  await client.entryRequest('entries/llm', 'PUT', entry)
  return client.publish()
}

/** Uploads screenshots, replaces the stored entry's listing, and requests a publication. */
export async function submitListing(
  source: { listing: Listing; media: MediaBlob[] },
  baseURL: string,
  token: string,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<CatalogPublication> {
  const client = catalogClient(baseURL, token, fetcher)
  const current = await client.currentEntry()
  if (!current) throw new Error('catalog has no llm entry yet; publish a release tag first')
  await uploadMedia(source.media, baseURL, token, fetcher)
  await client.entryRequest('entries/llm', 'PUT', renderListingUpdate(current, source.listing))
  return client.publish()
}

async function optionalListing(): Promise<{ listing: Listing; media: MediaBlob[] } | undefined> {
  const catalogDir = new URL('../catalog/', import.meta.url)
  if (!(await Bun.file(new URL('listing.yaml', catalogDir)).exists())) return undefined
  return loadListing(catalogDir)
}

async function main(): Promise<void> {
  const [subcommand, ...args] = Bun.argv.slice(2)
  const { values } = parseArgs({ args, options: { version: { type: 'string' }, digest: { type: 'string' } }, strict: true })
  if (subcommand === 'recorded') {
    if (!values.version || values.digest) throw new Error('usage: bun hack/publish-entry.ts recorded --version <semver>')
    validateRelease(values.version, `sha256:${'1'.repeat(64)}`)
    const token = process.env.CLOUD_CATALOG_ADMIN_TOKEN
    if (!token) throw new Error('CLOUD_CATALOG_ADMIN_TOKEN is required')
    const baseURL = (process.env.CLOUD_API_URL ?? 'https://api.appthrust.com').replace(/\/$/, '')
    const digest = await recordedDigest(values.version, baseURL, token)
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `digest=${digest ?? ''}\n`)
    console.log(digest ? `Catalog already records ${values.version} as ${digest}` : `Catalog has no image for ${values.version}`)
    return
  }
  if (subcommand === 'validate-listing') {
    const source = await optionalListing()
    if (!source) throw new Error('catalog/listing.yaml not found')
    console.log(`Listing valid: ${Object.keys(source.listing.locales).join(',')} locales, ${source.listing.highlights?.length ?? 0} highlights, ${source.media.length} screenshots (${source.media.reduce((sum, media) => sum + media.size, 0)} bytes)`)
    return
  }
  if (subcommand === 'listing') {
    if (values.version || values.digest) throw new Error('usage: bun hack/publish-entry.ts listing')
    const token = process.env.CLOUD_CATALOG_ADMIN_TOKEN
    if (!token) throw new Error('CLOUD_CATALOG_ADMIN_TOKEN is required')
    const baseURL = (process.env.CLOUD_API_URL ?? 'https://api.appthrust.com').replace(/\/$/, '')
    const source = await optionalListing()
    if (!source) throw new Error('catalog/listing.yaml not found')
    const publication = await submitListing(source, baseURL, token)
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `snapshot_id=${publication.id}\nstate=${publication.state}\n`)
    }
    console.log(`Catalog snapshot ${publication.id}: ${publication.state}`)
    return
  }
  if ((subcommand !== 'submit' && subcommand !== 'await') || !values.version || !values.digest) {
    throw new Error('usage: bun hack/publish-entry.ts <submit|await|recorded|listing|validate-listing> --version <semver> [--digest <sha256:hex>]')
  }
  validateRelease(values.version, values.digest)
  if (subcommand === 'submit') {
    const token = process.env.CLOUD_CATALOG_ADMIN_TOKEN
    if (!token) throw new Error('CLOUD_CATALOG_ADMIN_TOKEN is required')
    const baseURL = (process.env.CLOUD_API_URL ?? 'https://api.appthrust.com').replace(/\/$/, '')
    const template = await Bun.file(new URL('../catalog/entry.yaml', import.meta.url)).text()
    const publication = await submitEntry(template, values.version, values.digest, baseURL, token, fetch, await optionalListing())
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `snapshot_id=${publication.id}\nstate=${publication.state}\n`)
    }
    console.log(`Catalog snapshot ${publication.id}: ${publication.state}`)
    return
  }
  const deadline = Date.now() + 10 * 60_000
  while (Date.now() < deadline) {
    try {
      if (await publishedRelease(values.version, values.digest, deadline)) return
      console.log('Catalog does not yet contain the released version and image digest')
    } catch (error) {
      console.error(`Catalog not yet verified: ${error instanceof Error ? error.message : String(error)}`)
    }
    await Bun.sleep(Math.min(15_000, Math.max(0, deadline - Date.now())))
  }
  throw new Error(`catalog did not publish the signed llm ${values.version} image within 10 minutes`)
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
