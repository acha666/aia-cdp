// PLACEHOLDER (slice 1 foundation): exists only so `pnpm run types` can generate
// worker-configuration.d.ts. The HTTP/runtime work replaces it with the real Worker entry
// (slice 1 step 5: createApp + R2Store + ASSETS).
export default {
  fetch: () => new Response("placeholder", { status: 503 }),
} satisfies ExportedHandler<Env>;
