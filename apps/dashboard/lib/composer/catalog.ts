import 'server-only';

/** A function as a node's `GET /v1/resources` describes it. */
export interface CatalogFunction {
  name: string;
  returnType: string;
  description?: string;
  parameters: { name: string; type: string; description?: string }[];
  paymentManifest?: {
    costMicroUsd?: number;
    inputCostMicroUsdPerMillionTokens?: number;
    outputCostMicroUsdPerMillionTokens?: number;
    priceMicroUsdPerMillionTokens?: number;
  };
  restricted?: boolean;
  kind?: 'inference' | 'contract';
}

export interface CatalogResource {
  path: string;
  name: string;
  description?: string;
  website?: string;
  baseUrl: string;
  functions: CatalogFunction[];
}

/** The resources a script on one node can use: the node's own, then those it learned from peers. */
export interface Catalog {
  resources: CatalogResource[];
  /** True when the node has more resources than the Composer reads. */
  truncated: boolean;
}

/** At most this many resources go into the prompt. */
const MAX_RESOURCES = 500;
const PAGE_SIZE = 100;

/**
 * The URL the dashboard's server reaches a node at. Nodes report the base URL they are reached at by peers,
 * which can differ from the dashboard's view: locally, compose nodes report container hostnames while the
 * dashboard runs on the host. NODE_URL_REWRITES maps one to the other, as `from=to` pairs separated by commas.
 */
export function reachableNodeUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  for (const pair of (process.env.NODE_URL_REWRITES ?? '').split(',')) {
    const [from, to] = pair.split('=').map((part) => part?.trim().replace(/\/+$/, ''));
    if (from && to && (trimmed === from || trimmed.startsWith(`${from}/`))) return to + trimmed.slice(from.length);
  }
  return trimmed;
}

export async function fetchCatalog(baseUrl: string, signal?: AbortSignal): Promise<Catalog> {
  const resources: CatalogResource[] = [];
  let offset: number | undefined = 0;
  while (offset !== undefined && resources.length < MAX_RESOURCES) {
    const response = await fetch(`${reachableNodeUrl(baseUrl)}/v1/resources?offset=${offset}&limit=${PAGE_SIZE}`, { cache: 'no-store', signal });
    if (!response.ok) throw new Error(`The node's resource list returned ${response.status}`);
    const page = (await response.json()) as { resources: CatalogResource[]; nextOffset?: number | null };
    resources.push(...page.resources);
    offset = page.nextOffset ?? undefined;
  }
  return { resources: resources.slice(0, MAX_RESOURCES), truncated: offset !== undefined };
}

const usd = (microUsd: number) => `$${(microUsd / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;

function price(fn: CatalogFunction): string {
  const manifest = fn.paymentManifest;
  if (!manifest) return 'free';
  if (manifest.costMicroUsd !== undefined) return `${usd(manifest.costMicroUsd)} per call`;
  if (manifest.priceMicroUsdPerMillionTokens !== undefined) return `${usd(manifest.priceMicroUsdPerMillionTokens)} per million contract tokens`;
  return `${usd(manifest.inputCostMicroUsdPerMillionTokens ?? 0)}/M input tokens, ${usd(manifest.outputCostMicroUsdPerMillionTokens ?? 0)}/M output tokens`;
}

/** The catalog as compact signatures, for the system prompt. Sorted, so the same catalog renders the same bytes and stays cached. */
export function renderCatalog(catalog: Catalog): string {
  if (catalog.resources.length === 0) return 'This node knows no resources yet. Scripts can only compute with literals.';
  const lines: string[] = [];
  const sorted = [...catalog.resources].sort((a, b) => `${a.path}.${a.name}`.localeCompare(`${b.path}.${b.name}`));
  for (const resource of sorted) {
    lines.push(`${resource.path}.${resource.name}${resource.description ? ` — ${resource.description}` : ''}`);
    for (const fn of resource.functions) {
      const parameters = fn.parameters.map((p) => `${p.name}: ${p.type}`).join(', ');
      const notes = [fn.kind, price(fn), fn.restricted && 'restricted: needs a grant'].filter(Boolean).join('; ');
      lines.push(`  ${fn.name}(${parameters}): ${fn.returnType}  [${notes}]${fn.description ? ` — ${fn.description}` : ''}`);
      for (const parameter of fn.parameters) {
        if (parameter.description) lines.push(`    ${parameter.name}: ${parameter.description}`);
      }
    }
  }
  if (catalog.truncated) lines.push(`(Only the first ${MAX_RESOURCES} resources are listed.)`);
  return lines.join('\n');
}

export function findResource(catalog: Catalog, path: string, name: string): CatalogResource | undefined {
  return catalog.resources.find((resource) => resource.path === path && resource.name === name);
}
