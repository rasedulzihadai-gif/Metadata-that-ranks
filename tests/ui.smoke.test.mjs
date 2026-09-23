/* End-to-end UI smoke test: loads the real index.html in jsdom, drops in an image,
   and clicks "Generate metadata" while the best model is broken. Proves the page
   itself hands over to the next Gemini model and shows which one answered. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

const GOOD = JSON.stringify({
  content_type: "single_asset", description: "A calm blue ocean at sunset.",
  platforms: {
    adobe: { title: "Calm blue ocean at sunset", keywords: ["ocean", "sunset", "blue", "water", "sea"] },
    shutterstock: { description: "Calm blue ocean at sunset", keywords: ["ocean", "sunset"] },
    freepik: { title: "Calm blue ocean", keywords: ["ocean"] },
    istock: { title: "Calm blue ocean", description: "Calm blue ocean", keywords: ["ocean"] }
  }, category_suggestion: "Nature", flags: []
});
const res = (status, obj) => ({ ok: status >= 200 && status < 300, status, json: async () => obj });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 4000, what = "condition") {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(25); }
  throw new Error("timed out waiting for " + what);
}

async function boot(fetchImpl) {
  const errors = [], alerts = [], requests = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => errors.push(String(e && e.message || e)));
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc, url: "https://example.test/",
    beforeParse(window) {
      window.alert = m => alerts.push(String(m));
      window.URL.createObjectURL = () => "blob:fake";
      window.URL.revokeObjectURL = () => {};
      window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
      window.HTMLCanvasElement.prototype.toDataURL = () => "data:image/jpeg;base64,AAAA";
      window.Image = class { // jsdom never loads images, so fire onload ourselves
        set src(v) { this._src = v; setTimeout(() => this.onload && this.onload(), 0); }
        get src() { return this._src; }
        set width(v) {} get width() { return 1200; }
        set height(v) {} get height() { return 800; }
      };
      window.fetch = async (url, opts) => {
        requests.push({ url: String(url), opts: opts || {}, body: opts && opts.body ? JSON.parse(opts.body) : null });
        return fetchImpl(String(url), opts || {});
      };
    }
  });
  await new Promise(r => dom.window.document.readyState === "complete" ? r() : dom.window.addEventListener("load", r));
  await sleep(50);
  return { dom, w: dom.window, d: dom.window.document, errors, alerts, requests };
}

function dropFile(d, w, name = "ocean.jpg") {
  const input = d.getElementById("files");
  const file = new w.File([new Uint8Array([1, 2, 3])], name, { type: "image/jpeg" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new w.Event("change", { bubbles: true }));
}

const check = [];
const test = (n, f) => check.push([n, f]);
const ok = (c, m) => { if (!c) throw new Error(m || "assertion failed"); };
const eq = (a, b, m) => ok(a === b, (m || "not equal") + ` — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const has = (s, n) => ok(String(s).includes(n), `expected ${JSON.stringify(n)} inside: ${String(s).slice(0, 300)}`);

/* ---------- a healthy run, with the top model broken ---------- */
const brokenTop = (url) => {
  if (url.includes("/models?")) return res(200, { models: [
    { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3.7-flash", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3.1-flash-lite", supportedGenerationMethods: ["generateContent"] }
  ] });
  const m = (url.match(/models\/([^:]+):/) || [])[1];
  if (m === "gemini-3.8-flash") return res(404, { error: { message: "models/gemini-3.8-flash is not found" } });
  if (m === "gemini-3.7-flash") return res(200, { candidates: [{ content: { parts: [{ text: GOOD }] }, finishReason: "STOP" }] });
  return res(404, { error: { message: "not found" } });
};

test("page boots with Gemini as default provider and a visible chain", async () => {
  const { w, d, errors } = await boot(brokenTop);
  eq(errors.length, 0, "page threw errors: " + errors.join(" | "));
  const opts = [...d.getElementById("prov").options].map(o => o.value);
  ok(opts.includes("gemini"), "gemini must be offered");
  eq(d.getElementById("prov").value, "gemini", "gemini should be the default provider");
  eq(d.getElementById("burl").value, "https://generativelanguage.googleapis.com/v1beta");
  eq(d.getElementById("model").value, "auto");
  eq(d.getElementById("chainwrap").hidden, false, "the fallback chain panel should be visible");
  const rows = [...d.querySelectorAll("#chain .mrow code")].map(c => c.textContent);
  ok(rows.length >= 8, "the built-in chain should be listed, got " + rows.length);
  eq(rows[0], "gemini-3.8-flash");
  has(d.getElementById("chainnote").textContent, "models");
  w.close();
});

test("Check models lists the live models of the key", async () => {
  const { w, d, requests } = await boot(brokenTop);
  d.getElementById("key").value = "AIza-demo-key";
  d.getElementById("key").dispatchEvent(new w.Event("input", { bubbles: true }));
  d.getElementById("scan").click();
  await waitFor(() => /listed live/.test(d.getElementById("chainnote").textContent), 4000, "live listing");
  const listing = requests.find(r => r.url.includes("/models?"));
  ok(listing, "a /models request should have been made");
  eq(listing.opts.headers["x-goog-api-key"], "AIza-demo-key", "the key belongs in the x-goog-api-key header");
  const rows = [...d.querySelectorAll("#chain .mrow code")].map(c => c.textContent);
  eq(rows.length, 3, "the chain should now hold exactly the three listed models");
  w.close();
});

test("broken top model -> the next model answers, and the UI says which one", async () => {
  const { w, d, alerts, requests } = await boot(brokenTop);
  d.getElementById("key").value = "AIza-demo-key";
  d.getElementById("key").dispatchEvent(new w.Event("input", { bubbles: true }));
  dropFile(d, w);
  await waitFor(() => d.getElementById("bar").hidden === false, 4000, "the toolbar after a drop");
  d.getElementById("run").click();
  await waitFor(() => /via gemini-3\.7-flash/.test(d.getElementById("list").textContent), 6000, "metadata from the fallback model");
  const text = d.getElementById("list").textContent;
  has(text, "Single asset");
  has(text, "Calm blue ocean at sunset");
  has(text, "via gemini-3.7-flash");
  eq(alerts.length, 0, "no alert expected");
  const models = requests.filter(r => /:generateContent/.test(r.url)).map(r => (r.url.match(/models\/([^:]+):/) || [])[1]);
  eq(models[0], "gemini-3.8-flash", "the top model is tried first");
  eq(models[1], "gemini-3.7-flash", "then it hands over automatically");
  const row = [...d.querySelectorAll("#chain .mrow")].find(r => /gemini-3\.8-flash/.test(r.textContent));
  has(row.textContent, "not available", "the broken model should be shown as not available");
  has(d.getElementById("log").textContent, "gemini-3.8-flash", "the activity log should explain the switch");
  eq(d.getElementById("stat").textContent.includes("1/1 done"), true);
  w.close();
});

test("second image in the same session goes straight to the working model", async () => {
  const { w, d, requests } = await boot(brokenTop);
  d.getElementById("key").value = "AIza-demo-key";
  d.getElementById("key").dispatchEvent(new w.Event("input", { bubbles: true }));
  dropFile(d, w, "a.jpg");
  await waitFor(() => d.getElementById("bar").hidden === false);
  d.getElementById("run").click();
  await waitFor(() => /via gemini-3\.7-flash/.test(d.getElementById("list").textContent), 6000);
  dropFile(d, w, "b.jpg");
  await waitFor(() => d.querySelectorAll("#list .item").length === 2, 4000, "second image card");
  d.getElementById("run").click();
  await waitFor(() => d.getElementById("stat").textContent.includes("2/2 done"), 6000, "both images done");
  const models = requests.filter(r => /:generateContent/.test(r.url)).map(r => (r.url.match(/models\/([^:]+):/) || [])[1]);
  eq(models.filter(m => m === "gemini-3.8-flash").length, 1, "a retired model should not be retried on every image");
  eq(models.filter(m => m === "gemini-3.7-flash").length, 2);
  w.close();
});

test("no key -> a plain warning instead of a failed run", async () => {
  const { w, d, alerts } = await boot(brokenTop);
  dropFile(d, w);
  await waitFor(() => d.getElementById("bar").hidden === false);
  d.getElementById("run").click();
  await sleep(80);
  eq(alerts.length, 1);
  has(alerts[0], "Enter an API key");
  w.close();
});

test("everything broken -> a readable summary, not a stack trace", async () => {
  const allBroken = (url) => {
    if (url.includes("/models?")) return res(401, { error: { message: "API key not valid. Please pass a valid API key." } });
    return res(404, { error: { message: "model not found" } });
  };
  const { w, d } = await boot(allBroken);
  d.getElementById("key").value = "AIza-bad";
  d.getElementById("key").dispatchEvent(new w.Event("input", { bubbles: true }));
  dropFile(d, w);
  await waitFor(() => d.getElementById("bar").hidden === false);
  d.getElementById("run").click();
  await waitFor(() => /rejected|failed/i.test(d.getElementById("list").textContent), 6000, "an error card");
  const text = d.getElementById("list").textContent;
  ok(!/undefined|\[object/.test(text), "error text should be human readable: " + text);
  has(text, "not available");
  ok(text.length < 1200, "the error should stay short, got " + text.length + " chars");
  w.close();
});

for (const [name, fn] of check) {
  try { await fn(); console.log("  ✓ " + name); }
  catch (e) { console.log("  ✗ " + name + "\n      " + e.message); process.exitCode = 1; }
}
