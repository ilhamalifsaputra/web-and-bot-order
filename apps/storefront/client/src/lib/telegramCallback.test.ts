import { describe, it, expect, vi } from "vitest";
import { consumeTelegramFragment, parseTelegramFragment } from "./telegramCallback";

const payload = { id: 12345, first_name: "Nama 🌻", auth_date: 1770000000, hash: "a".repeat(64) };
const fragment = (value: unknown) => `#tgAuthResult=${Buffer.from(JSON.stringify(value)).toString("base64url")}`;

describe("Telegram callback fragment", () => {
  it("decodes signed public fields as UTF-8 without treating them as authenticated", () => {
    expect(parseTelegramFragment(fragment(payload))).toEqual({ ...payload, id: "12345", auth_date: "1770000000" });
  });
  it.each(["#tgAuthResult=%%%", "#tgAuthResult=e30", "#tgAuthResult=a&tgAuthResult=b", "#tgAuthResult=" + "a".repeat(17000), fragment({ ...payload, id: -1 }), fragment({ ...payload, id_token: "jwt" }), fragment({ ...payload, hash: "bad" })])("rejects malformed callback %#", (hash) => {
    expect(() => parseTelegramFragment(hash)).toThrow();
  });
  it("ignores an unrelated fragment", () => expect(parseTelegramFragment("#reviews")).toBeNull());
  it("scrubs the URL before posting the payload and navigates only to a safe internal result", async () => {
    const actions: string[] = [];
    const post = vi.fn(async (url: string, body: unknown) => { actions.push("post"); expect(url).toBe("/auth/telegram"); expect(body).toEqual({ ...payload, id: "12345", auth_date: "1770000000", state: "nonce", next: "/account" }); return { redirect: "/account" }; });
    await consumeTelegramFragment({ pathname: "/auth/telegram", search: "?state=nonce&next=%2Faccount", hash: fragment(payload) }, { replace: () => actions.push("scrub"), post, navigate: (path) => actions.push(path) });
    expect(actions).toEqual(["scrub", "post", "/account"]);
  });
  it("preserves the extracted payload when replaceState changes the live Location object", async () => {
    const location={pathname:"/auth/telegram",search:"?state=nonce",hash:fragment(payload)};
    const post=vi.fn(async()=>({redirect:"/account"}));
    await consumeTelegramFragment(location,{replace:()=>{location.hash="";},post,navigate:vi.fn()});
    expect(post).toHaveBeenCalledTimes(1);
  });
  it("scrubs malformed input and returns to a retryable login error without posting", async () => {
    const post = vi.fn(); const navigate = vi.fn(); const replace = vi.fn();
    await consumeTelegramFragment({ pathname: "/auth/telegram", search: "?next=%2Faccount", hash: "#tgAuthResult=%%%" }, { replace, post, navigate });
    expect(replace).toHaveBeenCalledTimes(1); expect(post).not.toHaveBeenCalled(); expect(navigate).toHaveBeenCalledWith("/login?next=%2Faccount&err=tg_failed");
  });
});
