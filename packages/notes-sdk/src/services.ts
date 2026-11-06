/* The services an app declares (schema `services`). Away from the
   platform there is no card reader: a card says nothing more than its
   address. Pictures from the web are fetched directly, which a site's CORS
   may refuse; then there is no picture. */

export interface WebResponse {
  status: number;
  contentType: string;
  bodyBase64: string | null;
}

export interface ServiceClient {
  call(method: string, input?: unknown): Promise<unknown>;
  request(method: string, input: { url: string }): Promise<WebResponse>;
}

const nothing: WebResponse = { status: 0, contentType: "", bodyBase64: null };

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export const services: ServiceClient = {
  async call() {
    return null;
  },
  async request(_method, input) {
    try {
      if (!/^https:\/\//i.test(input?.url ?? "")) return nothing;
      const response = await fetch(input.url, { mode: "cors", credentials: "omit", referrerPolicy: "no-referrer" });
      const blob = await response.blob();
      return { status: response.status, contentType: response.headers.get("content-type") ?? blob.type, bodyBase64: await base64(blob) };
    } catch {
      return nothing;
    }
  },
};
