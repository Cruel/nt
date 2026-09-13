# noveltea.dev

`site/` is the public NovelTea website package. Astro owns the custom marketing/download/examples pages and Starlight owns the public documentation surface.

## Local development

From the repository root, install workspace dependencies once with `pnpm install`, then run:

```sh
./scripts/run-site.sh
```

The runner first qualifies the exact public examples revision pinned by `nt`, then prepares Astro/Starlight content state and starts the normal Astro development server with HMR. By default the public examples checkout is expected at `~/dev/noveltea-examples`; set `NOVELTEA_EXAMPLES_ROOT` to use another checkout. Qualification builds the current checkout's CLI and canonical threaded Web player and materializes the same catalog/artifact shape used by CI under `build/site-examples`. Local development requires no Cloudflare credentials, Pages project, R2 bucket, or published NovelTea artifacts.

The `/examples/dev` surface receives COOP, COEP, and CORP headers from an Astro development middleware so the threaded Web-player showcase can run under the same isolation contract used in production. The Cloudflare Pages build receives the matching rules from `public/_headers`. `./scripts/run-site.sh --threaded` is the explicit production-parity entry point; the shared examples contract currently requires that threaded player, so the default local mode uses it as well.

The showcase consumes the qualified catalog rather than rebuilding Projects. Pages-eligible files are staged beneath `/examples/dev/assets`; oversized files are represented in `build/site-example-oversized/manifest.json` and production uploads them to the immutable `development/examples/<nt-revision>/<examples-revision>/` R2 namespace. The player HTML is rebased during staging so a Pages-hosted iframe can fetch an oversized Wasm module from `assets.noveltea.dev` without changing the user-facing example route. Public R2 CORS is GET/HEAD-only and allows cross-origin reads needed by the cross-origin-isolated player.

## Visual system

Custom marketing pages and Starlight share the tokens in `src/styles/tokens.css` plus the reusable NovelTea wordmark treatment. The marketing surface is intentionally dark-first and more expressive than the editor UI; documentation keeps Starlight's light/dark reading modes. Landing-page motion stays CSS-only and includes a `prefers-reduced-motion` fallback.

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
pnpm -C site run test:browser
```

The static tests verify the built routes, catalog, handoff actions, and isolation contract. The browser test serves the built site with the production isolation headers, starts both real qualified Wasm players, switches Materials to Verbs without navigating the surrounding page, and verifies that the old iframe is detached before the new runtime starts.

## Deployment

The main `Build` workflow owns the normal site dependency graph. Its reusable `site` job declares `needs: examples`, so GitHub starts site verification only after the same workflow run has produced and qualified `noveltea-development-examples`; no runner polls another workflow. Pull requests deploy a `pr-<number>` preview when repository secrets are available, and pushes to `master` deploy production. Other Build branches verify the site without deploying it.

After a tagged `Release` completes, `site-release.yml` performs a one-shot lookup of the already-successful Build for that exact release commit, copies its qualified examples artifact into the release-site run, and invokes the same reusable Site workflow. It fails closed if no successful Build exists rather than waiting or rebuilding the examples.

GitHub Actions uploads the verified `site/dist` with Wrangler to the Cloudflare Pages project `noveltea`. The reusable workflow uses these repository deployment inputs:

- secret `CLOUDFLARE_API_TOKEN`
- variable `CLOUDFLARE_ACCOUNT_ID`

The workflow creates the Pages project through Wrangler when it does not yet exist. The production custom-domain/DNS cutover to `noveltea.dev` is intentionally separate so the initial `*.pages.dev` deployment can be verified first.
