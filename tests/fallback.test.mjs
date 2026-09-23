/* Fallback engine tests for index.html.
   Loads the app's <script id="core"> in-process, swaps in a scripted fetch mock,
   and checks that a failing model always hands over to the next one. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const core = html.match(/<script id="core">([\s\S]*?)<\/script>/)[1];
if (!core) throw new Error("could not find <script id=\"core\"> in index.html");

function freshEngine() {
  new Function(core)();               // fresh module state, exposes globalThis.__MM
  return globalThis.__MM;
}
const res = (status, obj) => ({ ok: status >= 200 && status < 300, status, json: async () => obj, text: async () => JSON.stringify(obj) });
const rm = (status, obj) => { const e = new Error((obj.error && obj.error.message) || ("HTTP " + status)); e.status = status; return e; };

const GOOD = JSON.stringify({
  content_type: "single_asset", description: "A calm blue ocean at sunset.",
  platforms: {
    adobe: { title: "Calm blue ocean at sunset", keywords: ["ocean", "sunset", "blue", "water"] },
    shutterstock: { description: "Calm blue ocean at sunset", keywords: ["ocean", "sunset"] },
    freepik: { title: "Calm blue ocean", keywords: ["ocean"] },
    istock: { title: "Calm blue ocean", description: "Calm blue ocean", keywords: ["ocean"] }
  }, category_suggestion: "Nature", flags: []
});
const geminiOk = () => res(200, { candidates: [{ content: { parts: [{ text: GOOD }] }, finishReason: "STOP" }] });

let pass = 0, fail = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const ok = (cond, msg) => { if (!cond) throw new Error(msg || "assertion failed"); };
const eq = (a, b, msg) => ok(a === b, (msg || "not equal") + ` — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const has = (s, needle) => ok(String(s).includes(needle), `expected to find ${JSON.stringify(needle)} in:\n${s}`);

const req = (url, opts) => ({ url, opts, body: opts && opts.body ? JSON.parse(opts.body) : null });
/* only the requests that ask a model to answer; /models listings are bookkeeping */
const genCalls = calls => calls.filter(c => /:generateContent|\/chat\/completions|\/messages/.test(c.url));
const keysOf = opts => opts.headers["x-goog-api-key"] || (opts.headers.Authorization || "").replace("Bearer ", "");

/* ---------- 1. a retired/incapable model hands over to the next ---------- */
test("model fails -> next model in the chain answers", async () => {
  const MM = freshEngine();
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(req(url, opts));
    const m = url.match(/models\/([^:]+):generateContent/)[1];
    if (m === "gemini-3.8-flash") return res(404, { error: { message: "models/gemini-3.8-flash is not found for API version v1beta" } });
    if (m === "gemini-3.7-flash") return res(400, { error: { message: "This model does not support image input" } });
    if (m === "gemini-3.6-flash") return geminiOk();
    return res(404, { error: { message: "not found" } });
  };
  const p = MM.PROVIDERS.find(x => x.id === "gemini");
  const out = await MM.generate(p, { key: "k1", model: "", baseUrl: p.baseUrl }, { system: "s", text: "t", dataUrl: "data:image/jpeg;base64,AAAA" }, () => {});
  eq(out.model, "gemini-3.6-flash");
  const tried = calls.filter(c => c.url.includes(":generateContent")).map(c => c.url.match(/models\/([^:]+):/)[1]);
  eq(tried[0], "gemini-3.8-flash"); eq(tried[1], "gemini-3.7-flash"); eq(tried[2], "gemini-3.6-flash");
  eq(MM.mstate("gemini", "gemini-3.8-flash").dead, true, "retired model should be retired");
  eq(MM.mstate("gemini", "gemini-3.7-flash").dead, true, "model without image support should be retired");
  eq(MM.mstate("gemini", "gemini-3.6-flash").status, "ok");
});

/* ---------- 2. quota: cool down, skip while cooling, come back later ---------- */
test("429 quota -> cool down with RetryInfo, next model answers, cooling model is skipped", async () => {
  const MM = freshEngine();
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(req(url, opts));
    const m = url.match(/models\/([^:]+):generateContent/)[1];
    if (m === "gemini-3.8-flash") return res(429, { error: { message: "You exceeded your current quota, please retry in 30s", status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "30s" }] } });
    if (m === "gemini-3.7-flash") return geminiOk();
    return res(404, { error: { message: "not found" } });
  };
  const p = MM.PROVIDERS.find(x => x.id === "gemini");
  const cfg = { key: "k1", model: "", baseUrl: p.baseUrl };
  const out = await MM.generate(p, cfg, { system: "s", text: "t", dataUrl: "data:image/jpeg;base64,AAAA" }, () => {});
  eq(out.model, "gemini-3.7-flash");
  const st = MM.mstate("gemini", "gemini-3.8-flash");
  eq(st.status, "cooling");
  ok(Math.abs(st.until - Date.now() - 30000) < 2000, "cool-down should follow retryDelay (30s), got " + (st.until - Date.now()) + "ms");
  const before = genCalls(calls).length;
  const out2 = await MM.generate(p, cfg, { system: "s", text: "t", dataUrl: "data:image/jpeg;base64,BBBB" }, () => {});
  eq(out2.model, "gemini-3.7-flash");
  eq(genCalls(calls).length - before, 1, "a cooling model must not be called again");
});

test("daily quota -> parked for hours instead of seconds", async () => {
  const MM = freshEngine();
  globalThis.fetch = async (url) => {
    const m = url.match(/models\/([^:]+):generateContent/)[1];
    if (m === "gemini-3.8-flash") return res(429, { error: { message: "Quota exceeded. Limit: 200, requests per day (RPD)" } });
    return geminiOk();
  };
  const p = MM.PROVIDERS.find(x => x.id === "gemini");
  await MM.generate(p, { key: "k1", model: "", baseUrl: p.baseUrl }, { system: "s", text: "t", dataUrl: "data:image/jpeg;base64,AAAA" }, () => {});
  const st = MM.mstate("gemini", "gemini-3.8-flash");
  ok(st.until - Date.now() > 3600 * 1000, "a daily-quota 429 should park the model for hours, not seconds");
});

/* ---------- 3. several keys: rotate ---------- */
test("rejected key -> second key takes over, the chain stays the same", async () => {
  const MM = freshEngine();
  const used = [];
  globalThis.fetch = async (url, opts) => {
    const key = keysOf(opts); used.push(key);
    if (key === "bad") return res(401, { error: { message: "API key not valid. Please pass a valid API key." } });
    return geminiOk();
  };
  const p = MM.PROVIDERS.find(x => x.id === "gemini");
  const out = await MM.generate(p, { key: "bad, good", model: "", baseUrl: p.baseUrl }, { system: "s", text: "t", dataUrl: "data:image/jpeg;base64,AAAA" }, () => {});
  ok(used.includes("bad"), "the bad key should have been tried");
  answer: {
    const last = used[used.length - 1];
    eq(last, "good");
  }
  eq(out.key, "good");
});

test("every key rejected -> one clear message, no retry storm", async () => {
  const MM = freshEngine();
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push(req(url, opts)); return res(401, { error: { message: "API key not valid" } }); };
  const p = MM.PROVIDERS.find(x => x.id === "gemini");
  let err = null;
  try { await MM.generate(p, { key: "a, b", model: "", baseUrl: p.baseUrl }, { system: "s", text: "t", dataUrl: "data:image/jpeg;base64,AAAA" }, () => {}); }
  catch (e) { err = e; }
  ok(err, "should throw");
  has(err.message, "Every API key was rejected");
  eq(genCalls(calls).length, 2, "one attempt per key, then stop");
});

/* ---------- 4. live model list ---------- */
test("lists models live and ranks the newest flash first", async () => {
  const MM = freshEngine();
  let listed = 0;
  globalThis.fetch = async (url, opts) => {
    if (url.includes("/models?")) { listed++; return res(200, { models: [
      { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.1-flash-lite", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.7-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] },
      { name: "models/gemini-3.8-live", supportedGenerationMethods: ["generateContent"] },
      { name: "models/imagen-4", supportedGenerationMethods: ["predict"] }
    ] }); }
    if (url.match(/:generateContent/)) { const m = url.match(/models\/([^:]+):/)[1]; if (m === "gemini-3.8-flash") return geminiOk(); }
    return res(404, { error: { message: "not found" } });
  };
  const p = MM.PROVIDERS.find(x => x.id === "gemini");
  const ids = await MM.ensureDiscovered(p, { key: "k1", baseUrl: p.baseUrl });
  ok(!ids.includes("gemini-embedding-001"), "embedding models must be filtered out of the list request");
  eq(listed, 1);
  const order = MM.chainFor(p, { model: "auto", key: "k1", baseUrl: p.baseUrl });
  eq(order[0], "gemini-3.8-flash", "newest flash should lead the chain");
  ok(order.indexOf("gemini-3.7-flash") < order.indexOf("gemini-3.1-flash-lite"), "3.7 flash outranks a 3.1 lite");
  ok(order.indexOf("gemini-3.8-live") > order.indexOf("gemini-3.1-flash-lite"), "audio/live models belong at the end");
  const out = await MM.generate(p, { key: "k1", model: "auto", baseUrl: p.baseUrl }, { system: "s", text: "t", dataUrl: "data:image/jpeg;base64,AAAA" }, () => {});
  eq(out.model, "gemini-3.8-flash");
  eq(listed, 1, "the live list is fetched once per session");
});

test("typing models pins them to the front, in the order typed", async () => {
  const MM = freshEngine();
  globalThis.fetch = async () => geminiOk();
  const p = MM.PROVIDERS.find(x => x.id === "gemini");
  const order = MM.chainFor(p, { model: "gemini-2.5-flash, gemini-3.8-flash", key: "k1", baseUrl: p.baseUrl });
  eq(order[0], "gemini-2.5-flash");
  eq(order[1], "gemini-3.8-flash");
  ok(order.length > 5, "the rest of the chain still follows as backup");
});

/* ---------- 5. payload / network hiccups ---------- */
test("400 on a fancy body -> one retry with a minimal body, same model", async () => {
  const MM = freshEngine();
  const bodies = [];
  globalThis.fetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) return res(400, { error: { message: "Invalid JSON payload received. Unknown name 'x'" } });
    return geminiOk();
  };
  const p = MM.PROVIDERS.find(x => x.id === "gemini");
  const out = await MM.generate(p, { key: "k1", model: "", baseUrl: p.baseUrl }, { system: "s", text: "t", dataUrl: "data:image/jpeg;base64,AAAA" }, () => {});
  eq(out.model, "gemini-3.8-flash", "the same model should answer after the minimal retry");
  eq(bodies.length, 2);
  ok(bodies[0].generationConfig.responseMimeType === "application/json", "first try uses JSON mode");
  ok(bodies[1].generationConfig.responseMimeType === undefined, "second try drops JSON mode");
});

test("network error -> one quick retry, then the next model", async () => {
  const MM = freshEngine();
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(req(url, opts));
    const m = url.match(/models\/([^:]+):generateContent/)[1];
    if (calls <= 2) throw new TypeError("Failed to fetch");
    if (m === "gemini-3.7-flash") return geminiOk();
    return res(404, { error: { message: "not found" } });
  };
  const p = MM.PROVIDERS.find(x => x.id === "gemini");
  const out = await MM.generate(p, { key: "k1", model: "", baseUrl: p.baseUrl }, { system: "s", text: "t", dataUrl: "data:image/jpeg;base64,AAAA" }, () => {});
  eq(out.model, "gemini-3.7-flash");
  eq(calls.length, 3, "one retry on the dead model, then hand over");
});

test("safety block or empty answer is not mistaken for success", async () => {
  const MM = freshEngine();
  globalThis.fetch = async (url) => {
    const m = url.match(/models\/([^:]+):generateContent/)[1];
    if (m === "gemini-3.8-flash") return res(200, { promptFeedback: { blockReason: "PROHIBITED_CONTENT" }, candidates: [] });
    if (m === "gemini-3.7-flash") return res(200, { candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }] });
    return geminiOk();
  };
  const p = MM.PROVIDERS.find(x => x.id === "gemini");
  const out = await MM.generate(p, { key: "k1", model: "", baseUrl: p.baseUrl }, { system: "s", text: "t", dataUrl: "data:image/jpeg;base64,AAAA" }, () => {});
  eq(out.model, "gemini-3.6-flash");
});

/* ---------- 6. other providers still work through the same engine ---------- */
test("openai-compatible provider falls back too, and reads its own error shape", async () => {
  const MM = freshEngine();
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    if (url.includes("/models")) return res(404, { error: { message: "no listing" } });
    const body = opts.body ? JSON.parse(opts.body) : {};
    seen.push(body.model);
    if (body.model === "gpt-4o") return res(429, { error: { message: "Rate limit reached for gpt-4o" } });
    return res(200, { choices: [{ message: { content: GOOD } }] });
  };
  const p = MM.PROVIDERS.find(x => x.id === "openai");
  const out = await MM.generate(p, { key: "sk-x", model: "gpt-4o, gpt-4o-mini", baseUrl: p.baseUrl }, { system: "s", text: "t", dataUrl: "data:image/jpeg;base64,AAAA" }, () => {});
  eq(out.model, "gpt-4o-mini");
  eq(seen[0], "gpt-4o");
});

test("anthropic wire keeps its headers and picks up a 403 model error", async () => {
  const MM = freshEngine();
  let sawHeaders = null;
  globalThis.fetch = async (url, opts) => {
    sawHeaders = opts.headers;
    const body = JSON.parse(opts.body);
    if (body.model === "claude-sonnet-4-5") return res(403, { error: { message: "model: claude-sonnet-4-5 is not supported for this key" } });
    if (body.model === "claude-3-7-sonnet-latest") return res(200, { content: [{ text: GOOD }], stop_reason: "end_turn" });
    return res(404, { error: { message: "not found" } });
  };
  const p = MM.PROVIDERS.find(x => x.id === "anthropic");
  const out = await MM.generate(p, { key: "sk-ant", model: "", baseUrl: p.baseUrl }, { system: "s", text: "t", dataUrl: "data:image/jpeg;base64,AAAA" }, () => {});
  eq(out.model, "claude-3-7-sonnet-latest");
  eq(sawHeaders["anthropic-version"], "2023-06-01");
  has(sawHeaders["anthropic-dangerous-direct-browser-access"], "true");
});

/* ---------- 7. key parsing + metadata hygiene (regression) ---------- */
test("keys can be separated by comma, space, semicolon or newline", () => {
  const MM = freshEngine();
  const ks = MM.parseKeys("a,b \n c ;d,, a");
  eq(ks.join("|"), "a|b|c|d");
});

test("metadata rules still hold: trimming, dedupe, filler, replaceable text", () => {
  const MM = freshEngine();
  const m = MM.normalize(JSON.stringify({
    content_type: "template_pack",
    description: "x",
    platforms: {
      adobe: { title: "Modern poster template with flowing waves and spheres and mesh lines and bars", keywords: ["poster", "posters", "STUNNING", "Editable text", "mesh", "mesh"] },
      shutterstock: { description: "y", keywords: ["poster"] },
      freepik: { title: "t", keywords: [] },
      istock: { title: "t", description: "d", keywords: [] }
    },
    category_suggestion: "Backgrounds/Textures", flags: []
  }), "");
  ok(m.platforms.adobe.title.length <= 70, "title must respect the 70 char ceiling");
  eq(m.category_suggestion, "Graphic Resources", "template packs must not be filed as backgrounds");
  eq(m.platforms.adobe.keywords.length, 3, "dedupe + filler removal: poster, replaceable text, mesh");
  has(m.platforms.adobe.keywords.join(","), "replaceable text");
  ok(!m.platforms.adobe.keywords.includes("posters"), "singular/plural duplicates dropped");
});

/* ---------- runner ---------- */
for (const [name, fn] of tests) {
  try { await fn(); console.log("  ✓ " + name); pass++; }
  catch (e) { console.log("  ✗ " + name + "\n      " + e.message); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
