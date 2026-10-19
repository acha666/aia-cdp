import { createRouter, createWebHistory } from "vue-router";
import type { RouteRecordRaw, RouterHistory } from "vue-router";
import NotFoundPage from "@/pages/NotFoundPage.vue";
import OverviewPage from "@/pages/OverviewPage.vue";

const routes: RouteRecordRaw[] = [
  { path: "/", name: "overview", component: OverviewPage },
  // Detail pages are lazy-loaded (their own chunks); route params arrive as props.
  {
    path: "/certificates/:id",
    name: "certificate",
    component: () => import("@/pages/CertificatePage.vue"),
    props: true,
  },
  {
    path: "/crls/:targetId",
    name: "crl",
    component: () => import("@/pages/CrlPage.vue"),
    props: true,
  },
  { path: "/:pathMatch(.*)*", name: "not-found", component: NotFoundPage },
];

/** Tests pass `createMemoryHistory()`; the app uses the HTML5 history (the server has an SPA fallback). */
export function createAppRouter(history: RouterHistory = createWebHistory()) {
  return createRouter({ history, routes });
}
