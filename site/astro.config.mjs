import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const docsRenderChannel = process.env.NOVELTEA_DOCS_RENDER_CHANNEL === 'latest' ? 'latest' : 'dev';
const docsSidebarItems =
  docsRenderChannel === 'latest'
    ? [
        { label: 'Overview', link: '/docs/' },
        { label: 'Project schema reference', link: '/docs/reference/' },
      ]
    : [
        { label: 'Overview', slug: 'docs/dev' },
        { label: 'Project schema reference', slug: 'docs/dev/reference' },
      ];

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'cross-origin-isolated=(self "https://noveltea.pages.dev")',
};

function exampleIsolation() {
  return {
    name: 'noveltea-example-isolation',
    hooks: {
      'astro:server:setup': ({ server }) => {
        server.middlewares.use((request, response, next) => {
          const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
          if (pathname === '/examples/dev' || pathname.startsWith('/examples/dev/')) {
            for (const [name, value] of Object.entries(isolationHeaders)) {
              response.setHeader(name, value);
            }
          }
          next();
        });
      },
    },
  };
}

export default defineConfig({
  site: 'https://noveltea.dev',
  output: 'static',
  integrations: [
    exampleIsolation(),
    starlight({
      title: 'NovelTea',
      description: 'Build expressive narrative games with NovelTea.',
      customCss: ['./src/styles/tokens.css', './src/styles/starlight.css'],
      components: {
        PageTitle: './src/components/DocsChannelPageTitle.astro',
        SiteTitle: './src/components/DocsSiteTitle.astro',
      },
      sidebar: [
        {
          label: docsRenderChannel === 'latest' ? 'Latest' : 'Development',
          items: docsSidebarItems,
        },
      ],
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/Cruel/nt',
        },
      ],
    }),
  ],
});
