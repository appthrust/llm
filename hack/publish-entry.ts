import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import { parseArgs, promisify } from 'node:util'
import { YAML } from 'bun'

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

export function renderEntry(template: string, version: string, digest: string, previous?: CatalogEntry): CatalogEntry {
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
  return {
    slug: 'llm',
    definitionYAML: YAML.stringify(definition),
    versions: definition.spec.versions,
    updatePolicy: definition.spec.updatePolicy,
    display: { category: definition.spec.display.category, icon: definition.spec.display.iconRef?.name },
    publishedAt: previous?.publishedAt ?? null,
  }
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

export async function submitEntry(
  template: string,
  version: string,
  digest: string,
  baseURL: string,
  token: string,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<CatalogPublication> {
  validateRelease(version, digest)
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
  const current = await entryRequest('entries', 'GET') as { data: CatalogEntry[] }
  if (!Array.isArray(current.data)) throw new Error('catalog entries response must contain data[]')
  const entry = renderEntry(template, version, digest, current.data.find(entry => entry.slug === 'llm'))
  await entryRequest('entries/llm', 'PUT', entry)
  const response = await request('publish', 'POST')
  if (response.status !== 200 && response.status !== 202) throw new Error(`POST /catalog/publish failed (${response.status})`)
  const publication = await response.json() as CatalogPublication
  if (typeof publication.id !== 'string' || !publication.id || /[\r\n]/.test(publication.id) ||
    !(response.status === 202 && publication.state === 'queued' || response.status === 200 && publication.state === 'snapshot')) {
    throw new Error('catalog publish response must contain a queued (202) or snapshot (200) snapshot id')
  }
  return publication
}

async function main(): Promise<void> {
  const [subcommand, ...args] = Bun.argv.slice(2)
  const { values } = parseArgs({ args, options: { version: { type: 'string' }, digest: { type: 'string' } }, strict: true })
  if ((subcommand !== 'submit' && subcommand !== 'await') || !values.version || !values.digest) {
    throw new Error('usage: bun hack/publish-entry.ts <submit|await> --version <semver> --digest <sha256:hex>')
  }
  validateRelease(values.version, values.digest)
  if (subcommand === 'submit') {
    const token = process.env.CLOUD_CATALOG_ADMIN_TOKEN
    if (!token) throw new Error('CLOUD_CATALOG_ADMIN_TOKEN is required')
    const baseURL = (process.env.CLOUD_API_URL ?? 'https://api.appthrust.com').replace(/\/$/, '')
    const template = await Bun.file(new URL('../catalog/entry.yaml', import.meta.url)).text()
    const publication = await submitEntry(template, values.version, values.digest, baseURL, token)
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
