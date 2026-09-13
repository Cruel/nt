# noveltea.dev

`site/` is the public NovelTea website package. Astro owns the custom marketing/download/examples pages and Starlight owns the public documentation surface.

## Local development

From the repository root, install workspace dependencies once with `pnpm install`, then run:

```sh
./scripts/run-site.sh
```

The runner prepares Astro/Starlight content state and starts the normal Astro development server with HMR. Local development requires no Cloudflare credentials, Pages project, R2 bucket, or published NovelTea artifacts.

The `/examples/dev` surface receives COOP, COEP, and CORP headers from an Astro development middleware so the future threaded Web-player showcase can run under the same isolation contract used in production. The Cloudflare Pages build receives the matching rules from `public/_headers`.

## Documentation channels

`/docs/dev` always renders from the current checkout and is visibly marked unreleased/unstable. Before a public release exists, `/docs` renders the same development channel.

For production builds with a public release, the site workflow checks out the exact release tag separately and builds that revision with `NOVELTEA_DOCS_RENDER_CHANNEL=latest` and `NOVELTEA_DOCS_RELEASE_VERSION=<tag>`. `scripts/promote-release-docs.mjs` then promotes only that release-rendered documentation tree (plus its hashed Astro assets) to `/docs`, leaving the master-derived `/docs/dev` tree untouched. This keeps hand-authored docs and generated schema reference tied to the same released revision and leaves `/docs/<version>` available for future historical channels.

## Downloads and public releases

`/download` is release-manifest driven. Before the first qualified release exists it stays in an explicit active-development state and does not expose `master` artifacts as supported downloads.

Tagged release CI publishes qualified binaries to the public `Cruel/noveltea-releases` repository and emits `noveltea-release-manifest.json` with the exact source revision, supported editor/CLI assets, SHA-256 digests, sizes, and direct public asset URLs. The site workflow resolves the latest non-draft public distribution release, downloads that manifest, and passes its path through `NOVELTEA_RELEASE_MANIFEST_PATH` while building the site. The matching tag is still checked out from the private `nt` repository when release documentation is rendered, so downloads and latest documentation share the same release identity without making `nt` public.

The release manifest is validated before rendering. Product download links must point directly to `Cruel/noveltea-releases/releases/download/...`; source-repository release URLs are not accepted by the site contract.

## Verification

```sh
pnpm -C site run check
pnpm -C site run build
pnpm -C site run test
```

The tests operate on the static build output and verify the required shell routes plus the scoped example isolation contract.

## Deployment

GitHub Actions builds and directly uploads `site/dist` with Wrangler to the Cloudflare Pages project `noveltea`. Pull requests touching declared site inputs deploy a `pr-<number>` preview branch; pushes to `master` deploy the production branch.

The workflow uses these repository deployment inputs:

- secret `CLOUDFLARE_API_TOKEN`
- variable `CLOUDFLARE_ACCOUNT_ID`

The workflow creates the Pages project through Wrangler when it does not yet exist. The production custom-domain/DNS cutover to `noveltea.dev` is intentionally separate so the initial `*.pages.dev` deployment can be verified first.
