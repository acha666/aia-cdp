import { createRouter, createWebHistory } from "vue-router";
import type { RouteRecordRaw, RouterHistory, RouterScrollBehavior } from "vue-router";
import NotFoundPage from "@/pages/NotFoundPage.vue";
import OverviewPage from "@/pages/OverviewPage.vue";

// Detail routes only match well-formed ids in the lowercase form the API sends (`sensitive`: the
// router ignores case by default): a certificate id is the SHA-256 of the DER, a target id a UUID.
// Anything else is NotFoundPage and never reaches a fetch (plan §10 #2): hono/client puts path
// parameters into the URL unencoded, so `../stats` would otherwise request /api/v1/stats.
const CERTIFICATE_ID = "[0-9a-f]{64}";
const TARGET_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const routes: RouteRecordRaw[] = [
  { path: "/", name: "overview", component: OverviewPage },
  // Detail pages are lazy-loaded (their own chunks); route params arrive as props.
  {
    path: `/certificates/:id(${CERTIFICATE_ID})`,
    name: "certificate",
    component: () => import("@/pages/CertificatePage.vue"),
    props: true,
    sensitive: true,
  },
  {
    path: `/crls/:targetId(${TARGET_ID})`,
    name: "crl",
    component: () => import("@/pages/CrlTargetPage.vue"),
    props: true,
    sensitive: true,
  },
  { path: "/:pathMatch(.*)*", name: "not-found", component: NotFoundPage },
];

// Without a scrollBehavior a link keeps the previous page's offset: a page whose data is cached
// renders at full height at once and opens scrolled down (on a phone, at its footer). Back and
// forward return to where the page was; a fragment (the skip link) and a change of only the query
// or fragment stay on the page.
const scrollBehavior: RouterScrollBehavior = (to, from, saved) => {
  if (saved) {
    return saved;
  }
  if (to.hash) {
    return { el: to.hash };
  }
  return to.path === from.path ? false : { top: 0 };
};

/** Tests pass `createMemoryHistory()`; the app uses the HTML5 history (the server has an SPA fallback). */
export function createAppRouter(history: RouterHistory = createWebHistory()) {
  return createRouter({ history, routes, scrollBehavior });
}
