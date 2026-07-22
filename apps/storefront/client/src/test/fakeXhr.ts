/** Minimal fake XHR for tests — jsdom's real XMLHttpRequest attempts an
 * actual network request, so anything that needs upload progress (only
 * available via `xhr.upload.onprogress`, not `fetch`) has to drive the
 * request/response by hand. Install with:
 *   vi.stubGlobal("XMLHttpRequest", FakeXHR as unknown as typeof XMLHttpRequest);
 * and reset `FakeXHR.instances = []` in `beforeEach`. Mirrors
 * apps/web-admin/client/src/test/fakeXhr.ts (separate app, separate `@`
 * alias root, so not shared directly). */
export class FakeXHR {
  static instances: FakeXHR[] = [];
  method = "";
  url = "";
  status = 0;
  responseText = "";
  withCredentials = false;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sentBody: FormData | null = null;
  requestHeaders: Record<string, string> = {};

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.requestHeaders[name] = value;
  }
  send(body: FormData) {
    this.sentBody = body;
    FakeXHR.instances.push(this);
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  respond(status: number, body: string) {
    this.status = status;
    this.responseText = body;
    this.onload?.();
  }
}
