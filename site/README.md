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
