import type { APIRoute, GetStaticPaths } from 'astro';
import { createNovelTeaRawSchemaFiles } from '../../../../../../../editor/src/shared/project-schema/schema-reference';

const schemas = createNovelTeaRawSchemaFiles();

export const getStaticPaths: GetStaticPaths = () =>
  Object.entries(schemas).map(([relativePath, body]) => ({
    params: { schema: relativePath.replace(/\.json$/, '') },
    props: { body },
  }));

export const GET: APIRoute = ({ props }) =>
  new Response(props.body as string, {
    headers: {
      'Content-Type': 'application/schema+json; charset=utf-8',
    },
  });
