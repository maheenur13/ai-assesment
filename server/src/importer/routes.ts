import { Router } from 'express';
import { z } from 'zod';
import { requireOperator } from '../http/auth.js';
import { parse } from '../http/validate.js';
import { idParam } from '../modules/shared.js';
import type { ImportService } from './service.js';

export const createImportBody = z
  .object({
    url: z
      .url({ protocol: /^https?$/ })
      .max(2_048)
      .describe('Public link to a CSV or JSON file, or a Google Sheets share link'),
    dryRun: z
      .boolean()
      .default(true)
      .describe('Preview only (default). Send false to write the products.'),
  })
  .strict()
  .meta({ id: 'CreateImport' });

const action = z.enum(['created', 'updated', 'unchanged', 'failed']);
export const importRunSchema = z
  .object({
    id: z.uuid(),
    sourceUrl: z.string(),
    dryRun: z.boolean(),
    mapping: z.object({
      fields: z.record(z.string(), z.string()).describe('Product field → source column'),
      source: z.enum(['aliases', 'model']),
    }),
    counts: z.record(action, z.number().int()),
    rows: z.array(
      z.object({
        row: z.number().int().describe('1-based record number, header not counted'),
        sku: z.string().nullable(),
        action: action.describe('For a dry run: what an import would do'),
        errors: z.array(z.string()).optional(),
      }),
    ),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'ImportRun' });

export function importRoutes(imports: ImportService): Router {
  const router = Router();
  router.use(requireOperator);

  router.post('/', async (req, res) => {
    const run = await imports.run(parse(createImportBody, req.body, 'body'), req.log);
    res.status(201).location(`${req.baseUrl}/${run.id}`).json(run);
  });

  router.get('/:id', async (req, res) => {
    res.json(await imports.get(idParam(req.params.id, 'Import')));
  });

  return router;
}
