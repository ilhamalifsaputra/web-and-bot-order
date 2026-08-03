/** Minimal fake XHR for tests — jsdom's real XMLHttpRequest attempts an
 * actual network request, so anything that needs upload progress (only
 * available via `xhr.upload.onprogress`, not `fetch`) has to drive the
 * request/response by hand. Install with:
 *   vi.stubGlobal("XMLHttpRequest", FakeXHR as unknown as typeof XMLHttpRequest);
 * and reset `FakeXHR.instances = []` in `beforeEach`. */
export class FakeXHR {
  static instances: FakeXHR[] = [];
  method = "";
  url = "";
  status = 0;
  responseText = "";
  withCredentials = false;
  timeout = 0;
  upload: {
    onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
    onload: (() => void) | null;
  } = {
    onprogress: null,
    onload: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  sentBody: FormData | null = null;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader() {}
  send(body: FormData) {
    this.sentBody = body;
    FakeXHR.instances.push(this);
  }
  /** Fires the upload's progress event and, once every byte has left the
   * browser (`loaded >= total`), its `load` event too — the real XHR upload
   * fires both, in that order, so tests can drive a single `progress()` call
   * and still observe the post-upload phase transition it triggers. */
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
    if (loaded >= total) this.upload.onload?.();
  }
  respond(status: number, body: string) {
    this.status = status;
    this.responseText = body;
    this.onload?.();
  }
  /** Simulates the browser giving up after `xhr.timeout` ms with no
   * response, so tests can assert the timeout path without actually waiting
   * out the real timeout window. */
  triggerTimeout() {
    this.ontimeout?.();
  }
}
