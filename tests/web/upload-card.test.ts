// The CRL upload card (implementation slice 5b step 7) against a stubbed fetch: what it sends, the
// three outcomes, the error texts, the optional token, and the input rules kept from
// worker-aia-cdp@5b570aa:src/web/components/CrlUpload.vue.
import { VueQueryPlugin } from "@tanstack/vue-query";
import type { QueryClient } from "@tanstack/vue-query";
import { flushPromises, mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "vue-sonner";
import { deferred, envelope, publishedCrl, stubApi, targetItems } from "./helpers";
import type { Handler } from "./helpers";
import { createQueryClient, queryKeys } from "@/client/queries";
import type { PublishedCrl } from "@/client/types";
import CrlUploadCard from "@/components/overview/CrlUploadCard.vue";
import { useUploadToken } from "@/composables/useUploadToken";
import { createAppI18n } from "@/i18n";

const PEM =
  "-----BEGIN X509 CRL-----\nMIIBszCBnAIBATANBgkqhkiG9w0BAQsFADAA\n-----END X509 CRL-----\n";

let wrapper: VueWrapper | undefined;
let client: QueryClient | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  client?.clear();
  useUploadToken().value = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function render(post: Handler, options: { cachedTargets?: boolean } = {}) {
  const api = stubApi({ "POST /api/v1/crls": post });
  client = createQueryClient();
  if (options.cachedTargets !== false) {
    client.setQueryData(queryKeys.crls, targetItems());
  }
  wrapper = mount(CrlUploadCard, {
    attachTo: document.body,
    global: { plugins: [createAppI18n("en"), [VueQueryPlugin, { queryClient: client }]] },
  });
  const posts = () =>
    api.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => init!);
  return { card: wrapper, posts };
}

const ok = (outcome: PublishedCrl["outcome"]) => () =>
  Response.json(publishedCrl(outcome), { status: outcome === "created" ? 201 : 200 });

async function paste(card: VueWrapper, text: string) {
  await card.get("textarea").setValue(text);
}

async function submit(card: VueWrapper) {
  await card.get("form").trigger("submit");
  await flushPromises();
}

describe("CrlUploadCard", () => {
  it("sends pasted PEM as a file in the multipart field crl, never as a string field", async () => {
    const { card, posts } = render(ok("created"));
    await paste(card, PEM);
    await submit(card);

    expect(posts()).toHaveLength(1);
    const body = posts()[0]!.body;
    expect(body).toBeInstanceOf(FormData);
    const field = (body as FormData).get("crl");
    expect(field).toBeInstanceOf(File);
    expect((field as File).name).toBe("crl.pem");
    expect((field as File).type).toBe("application/x-pem-file");
    expect(await (field as File).text()).toBe(PEM);
    expect([...(body as FormData).keys()]).toEqual(["crl"]);
  });

  it("sends a dropped file as it is, the first of several", async () => {
    const { card, posts } = render(ok("updated"));
    const der = new File([new Uint8Array([0x30, 0x82, 0x01])], "full.crl");
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { files: [der, new File(["x"], "second.crl")] },
    });
    card.get('[data-testid="drop-zone"]').element.dispatchEvent(drop);
    await flushPromises();
    expect(card.get('[data-testid="upload-helper"]').text()).toBe("full.crl");

    await submit(card);
    expect((posts()[0]!.body as FormData).get("crl")).toBe(der);
  });

  it("takes a chosen file and resets the file input", async () => {
    const { card } = render(ok("created"));
    const chosen = new File(["-----BEGIN X509 CRL-----"], "issuing.pem");
    const element = card.get('[data-testid="file-input"]').element as HTMLInputElement;
    const values: string[] = [];
    Object.defineProperty(element, "files", { value: [chosen] });
    Object.defineProperty(element, "value", {
      get: () => "",
      set: (value: string) => values.push(value),
    });
    element.dispatchEvent(new Event("change"));
    await flushPromises();

    expect(card.get('[data-testid="upload-helper"]').text()).toBe("issuing.pem");
    expect(values).toEqual([""]);
  });

  it.each([
    ["created", "Published to Issuing CA 01: its first CRL."],
    ["updated", "Published to Issuing CA 01: it replaces the previous CRL."],
    ["unchanged", "Issuing CA 01 already serves this CRL; nothing changed."],
  ] as const)("reports %s as a success with the target's label", async (outcome, text) => {
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");
    const { card } = render(ok(outcome));
    await paste(card, PEM);
    await submit(card);

    expect(success).toHaveBeenCalledWith(text);
    expect(error).not.toHaveBeenCalled();
    const alert = card.get('[data-testid="upload-success"]');
    expect(alert.text()).toContain(text);
    expect(alert.text()).toContain("CRL #3");
    expect(alert.findAll("a").map((link) => link.attributes("href"))).toEqual([
      "/crl/ca01.crl",
      "/crl/ca01.crl.pem",
    ]);
    expect(card.find('[data-testid="upload-error"]').exists()).toBe(false);
    // The input was not changed meanwhile: it is cleared.
    expect((card.get("textarea").element as HTMLTextAreaElement).value).toBe("");
  });

  it("names the kind when the target list is not cached", async () => {
    const { card } = render(ok("created"), { cachedTargets: false });
    await paste(card, PEM);
    await submit(card);

    expect(card.get('[data-testid="upload-success"]').text()).toContain(
      "Published to the full CRL target: its first CRL."
    );
  });

  it.each([
    [
      "stale_crl",
      () => envelope(409, "stale_crl"),
      "The CRL is older than the target's current CRL.",
    ],
    [
      "invalid_crl",
      () => envelope(422, "invalid_crl", { reason: "pem_blocks" }),
      "This is not a valid X.509 CRL.",
    ],
    [
      "a code of a newer server",
      () => envelope(422, "future_code"),
      "Unexpected error (future_code).",
    ],
    [
      "no response",
      () => Promise.reject(new TypeError("Failed to fetch")),
      "The server could not be reached.",
    ],
  ])("shows %s as a toast and an inline error", async (_, answer, text) => {
    const error = vi.spyOn(toast, "error");
    const { card } = render(answer);
    await paste(card, PEM);
    await submit(card);

    expect(error).toHaveBeenCalledWith(text);
    const alert = card.get('[data-testid="upload-error"]');
    expect(alert.attributes("role")).toBe("alert");
    expect(alert.text()).toContain("Upload failed");
    expect(alert.text()).toContain(text);
    // A failed input stays for another try.
    expect((card.get("textarea").element as HTMLTextAreaElement).value).toBe(PEM);
  });

  it("explains details.reason, and shows a reason it does not know as it is", async () => {
    const { card } = render(() => envelope(422, "invalid_crl", { reason: "pem_blocks" }));
    await paste(card, PEM);
    await submit(card);
    expect(card.get('[data-testid="upload-error"]').text()).toContain(
      "Reason: the text must contain exactly one complete PEM block"
    );

    wrapper?.unmount();
    const second = render(() => envelope(422, "invalid_crl", { reason: "something_new" }));
    await paste(second.card, PEM);
    await submit(second.card);
    expect(second.card.get('[data-testid="upload-error"]').text()).toContain(
      "Reason: something_new"
    );
  });

  it("opens and focuses the token field on 401, then sends the token as a bearer header", async () => {
    let calls = 0;
    const { card, posts } = render(() => {
      calls += 1;
      return calls === 1 ? envelope(401, "unauthorized") : ok("created")();
    });
    expect(card.find('[data-testid="token-input"]').exists()).toBe(false);

    await paste(card, PEM);
    await submit(card);
    // No token: no Authorization header at all (an empty one is bearerAuth's 400).
    expect(new Headers(posts()[0]!.headers).has("Authorization")).toBe(false);
    const field = card.get('[data-testid="token-input"]');
    expect(document.activeElement).toBe(field.element);
    expect(card.get('[data-testid="upload-error"]').text()).toContain(
      "The upload token is missing or wrong."
    );

    await field.setValue("  s3cret-token  ");
    await submit(card);
    expect(new Headers(posts()[1]!.headers).get("Authorization")).toBe("Bearer s3cret-token");
    expect(card.find('[data-testid="upload-success"]').exists()).toBe(true);
    // Memory only.
    expect(JSON.stringify({ ...localStorage })).not.toContain("s3cret");
    expect(JSON.stringify({ ...sessionStorage })).not.toContain("s3cret");
  });

  it("does not submit again while an upload runs", async () => {
    const pending = deferred<Response>();
    const { card, posts } = render(() => pending.promise);
    await paste(card, PEM);

    const form = card.get("form");
    await form.trigger("submit");
    await form.trigger("submit");
    await flushPromises();
    expect(posts()).toHaveLength(1);
    const button = card.get('[data-testid="upload-submit"]');
    expect(button.attributes("disabled")).toBeDefined();
    expect(button.text()).toBe("Uploading…");

    pending.resolve(ok("created")());
    await flushPromises();
    // Done, and disabled again because the (unchanged) input was cleared.
    expect(button.text()).toBe("Upload CRL");
    expect(button.attributes("disabled")).toBeDefined();
    expect(posts()).toHaveLength(1);
  });

  it("keeps an input that changed while the upload ran", async () => {
    const pending = deferred<Response>();
    const { card } = render(() => pending.promise);
    await paste(card, PEM);
    await card.get("form").trigger("submit");
    await paste(card, `${PEM}\n`);

    pending.resolve(ok("created")());
    await flushPromises();
    expect(card.find('[data-testid="upload-success"]').exists()).toBe(true);
    expect((card.get("textarea").element as HTMLTextAreaElement).value).toBe(`${PEM}\n`);
  });

  it("hints at invalid PEM only for text that is there", async () => {
    const { card, posts } = render(ok("created"));
    expect(card.find('[data-testid="pem-hint"]').exists()).toBe(false);
    expect(card.get('[data-testid="upload-submit"]').attributes("disabled")).toBeDefined();

    await paste(card, "   \n");
    expect(card.find('[data-testid="pem-hint"]').exists()).toBe(false);
    await paste(card, "not a CRL");
    expect(card.get('[data-testid="pem-hint"]').text()).toBe(
      "Invalid PEM format. Must contain X509 CRL markers."
    );
    await submit(card);
    expect(posts()).toHaveLength(0);
  });
});
