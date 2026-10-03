import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

const docsRenderChannel = process.env.NOVELTEA_DOCS_RENDER_CHANNEL === "latest" ? "latest" : "dev";
const docsItem = (label, path = "") =>
  docsRenderChannel === "latest"
    ? { label, link: `/docs/${path ? `${path}/` : ""}` }
    : { label, slug: `docs/dev${path ? `/${path}` : ""}` };
const docsSidebarItems = [
  docsItem("Overview"),
  docsItem("Authoring model", "concepts/overview"),
  docsItem("Project model and state", "concepts/project-model"),
  docsItem("World and objects", "concepts/world-and-objects"),
  docsItem("Verbs and interactions", "concepts/interactions"),
  docsItem("Characters, Dialogues, and Scenes", "concepts/story"),
  docsItem("Layouts, materials, and localization", "concepts/presentation-and-localization"),
  docsItem("Authored Tests", "concepts/authored-tests"),
  docsItem("Project schema reference", "reference"),
];

const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": 'cross-origin-isolated=(self "https://noveltea.pages.dev")',
};

function exampleIsolation() {
  return {
    name: "noveltea-example-isolation",
    hooks: {
      "astro:server:setup": ({ server }) => {
        server.middlewares.use((request, response, next) => {
          const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
          if (pathname === "/examples" || pathname.startsWith("/examples/")) {
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
  site: "https://noveltea.dev",
  output: "static",
  integrations: [
    exampleIsolation(),
    starlight({
      title: "NovelTea",
      description: "Build expressive narrative games with NovelTea.",
      customCss: ["./src/styles/tokens.css", "./src/styles/starlight.css"],
      components: {
        PageTitle: "./src/components/DocsChannelPageTitle.astro",
        SiteTitle: "./src/components/DocsSiteTitle.astro",
      },
      sidebar: [
        {
          label: docsRenderChannel === "latest" ? "Latest" : "Development",
          items: docsSidebarItems,
        },
      ],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/Cruel/nt",
        },
      ],
    }),
  ],
});
