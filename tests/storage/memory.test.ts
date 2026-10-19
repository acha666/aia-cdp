import { MemoryStore } from "../../src/storage/memory.ts";
import { describeObjectStore } from "./conformance.ts";

describeObjectStore("memory", () => new MemoryStore());
