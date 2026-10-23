// Public certificate reads (plan §7.1): GET /api/v1/certificates and /api/v1/certificates/{id}, the
// views of src/core/views.ts. A public sub-app, so it joins the AppType chain. Each request reads
// config.json and catalog.json once (plan §5.6); the detail also reads its blob. The id is the
// certificate's SHA-256, never a store key (an archive-style id is a 400).
//
// Failures are thrown: ApiError for the 404, and for the 500 a blob the catalog names that is
// missing or wrong, or a store error, so onError writes every envelope (no-store) and the handlers
// only return successes. HEAD is Hono's automatic HEAD of each GET.
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { readState } from "../../core/catalog.ts";
import { certificateDetail, certificateList } from "../../core/views.ts";
import { ApiError, NO_STORE } from "../errors.ts";
import {
  BadRequestError,
  CertificateDetail,
  CertificateIdParam,
  CertificateListItem,
  INTERNAL_ERROR,
  jsonContent,
  NotFoundError,
} from "../schemas.ts";
import type { AppDeps } from "../types.ts";

const TAGS = ["certificates"];

export const listCertificatesRoute = createRoute({
  method: "get",
  path: "/certificates",
  operationId: "listCertificates",
  summary: "List certificates",
  description:
    "Every imported certificate, in id order, with its catalog summary, config.json label, " +
    "download paths and the targets it issues CRLs for. The whole list: no pagination.",
  tags: TAGS,
  responses: {
    200: { description: "The certificates", content: jsonContent(CertificateListItem.array()) },
    500: INTERNAL_ERROR,
  },
});

export const getCertificateRoute = createRoute({
  method: "get",
  path: "/certificates/{id}",
  operationId: "getCertificate",
  summary: "Get a certificate",
  description:
    "The list item plus the decoded certificate: fingerprints, TBSCertificate (names, validity, " +
    "public key, every extension), signature algorithm with its parameters and signature value.",
  tags: TAGS,
  request: { params: CertificateIdParam },
  responses: {
    200: { description: "The certificate", content: jsonContent(CertificateDetail) },
    400: { description: "The id is not 64 hex digits", content: jsonContent(BadRequestError) },
    404: {
      description: "No certificate with this id is imported",
      content: jsonContent(NotFoundError),
    },
    500: INTERNAL_ERROR,
  },
});

export function certificateRoutes(deps: AppDeps) {
  return new OpenAPIHono()
    .openapi(listCertificatesRoute, async (c) => {
      const { config, catalog } = await readState(deps.store);
      return c.json(certificateList(config, catalog), 200, NO_STORE);
    })
    .openapi(getCertificateRoute, async (c) => {
      const { id } = c.req.valid("param");
      const { config, catalog } = await readState(deps.store);
      const detail = await certificateDetail(deps.store, config, catalog, id);
      if (detail === undefined) {
        throw new ApiError(404, "not_found", "No certificate with this id is imported");
      }
      return c.json(detail, 200, NO_STORE);
    });
}
