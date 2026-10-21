import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { createApp } from "vue";
import App from "./App.vue";
import { createAppI18n } from "./i18n";
import { createAppRouter } from "./router";
import "./styles/main.css";
// vue-sonner 2 no longer injects its styles at run time (implementation B2).
import "vue-sonner/style.css";

// staleTime 0: every mount and window focus refetches; API responses are `no-store` anyway.
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 0 } },
});

createApp(App)
  .use(createAppRouter())
  .use(createAppI18n())
  .use(VueQueryPlugin, { queryClient })
  .mount("#app");
