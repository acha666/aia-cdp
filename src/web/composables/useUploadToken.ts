import { shallowRef } from "vue";

// The upload token (AIA_UPLOAD_TOKEN) the operator typed into the upload card. Memory only: never
// localStorage or sessionStorage, so it is gone with the page; it survives a visit to a detail
// page and back.
const token = shallowRef("");

export function useUploadToken() {
  return token;
}
