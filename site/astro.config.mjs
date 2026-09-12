import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
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
      sidebar: [
        {
          label: 'Development',
          items: [{ label: 'Overview', slug: 'docs/dev' }],
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
