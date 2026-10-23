// Unmounts every component a test mounted, after its own afterEach hooks.
import { enableAutoUnmount } from "@vue/test-utils";
import { afterEach } from "vitest";

enableAutoUnmount(afterEach);
