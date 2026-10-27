// The API's response bodies the UI renders, all type-only: nothing here reaches the bundle. They
// are inferred by hc from the routes, so they cannot drift from the server's schemas.
import type { InferResponseType } from "hono/client";
import type { api } from "./api";

type V1 = typeof api.api.v1;

/** GET /api/v1/certificates: every imported certificate, in id order. */
export type CertificateList = InferResponseType<V1["certificates"]["$get"], 200>;
export type CertificateListItem = CertificateList[number];

/** GET /api/v1/crls: one item per configured target, in targetId order. */
export type CrlTargetList = InferResponseType<V1["crls"]["$get"], 200>;
export type CrlTargetListItem = CrlTargetList[number];

/** POST /api/v1/crls: the same body for 201 created and 200 updated / unchanged. */
export type PublishedCrl = InferResponseType<V1["crls"]["$post"], 200 | 201>;
