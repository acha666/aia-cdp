import { useTitle } from "@vueuse/core";
import { toValue } from "vue";
import type { MaybeRefOrGetter } from "vue";
import { siteName } from "@/site";

/** document.title as "<page> · <site name>" while the calling page is mounted (plan §8). */
export function usePageTitle(page: MaybeRefOrGetter<string>): void {
  useTitle(() => `${toValue(page)} · ${siteName}`);
}
