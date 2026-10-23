// Types the UI renders, all type-only: nothing here reaches the bundle. The X.509 projection comes
// from core under its own names (Name, GeneralName, Extension, Extensions, DistributionPoint,
// Asn1Line, AlgorithmIdentifier, ParsedExtensionValue and ExtensionType, …); the response bodies
// are inferred by hc from the routes, so they cannot drift from the server's schemas.
import type { InferResponseType } from "hono/client";
import type { api } from "./api";

export type * from "../../core/summary/schemas.ts";

type V1 = typeof api.api.v1;

/** GET /api/v1/certificates: every imported certificate, in id order. */
export type CertificateList = InferResponseType<V1["certificates"]["$get"], 200>;
export type CertificateListItem = CertificateList[number];

/** GET /api/v1/certificates/{id}. */
export type CertificateDetail = InferResponseType<V1["certificates"][":id"]["$get"], 200>;

/** GET /api/v1/crls: one item per configured target, in targetId order. */
export type CrlTargetList = InferResponseType<V1["crls"]["$get"], 200>;
export type CrlTargetListItem = CrlTargetList[number];

/** GET /api/v1/crls/{targetId}: `current` is null while nothing is published. */
export type CrlTargetDetail = InferResponseType<V1["crls"][":targetId"]["$get"], 200>;

/** GET /api/v1/stats. */
export type Stats = InferResponseType<V1["stats"]["$get"], 200>;

/** POST /api/v1/crls: the same body for 201 created and 200 updated / unchanged. */
export type PublishedCrl = InferResponseType<V1["crls"]["$post"], 200 | 201>;
