# Metadata that ranks

Drop images, get microstock titles/keywords for Adobe Stock, Shutterstock, Freepik and iStock —
plus a vector/pack aware rule engine (`single_asset` vs `template_pack`).

Open `index.html` directly in a browser, or run the tiny static server:

```bash
npm run dev          # http://localhost:4173
npm test             # core fallback tests + jsdom UI smoke test
node tests/fallback.test.mjs   # core tests only — no dependencies needed
```

Only `tests/ui.smoke.test.mjs` needs `npm install` (jsdom). The app itself has no build step and no dependencies.

## Model fallback (Gemini free tier, and everything else)

The API key goes straight from the browser to the provider. What is new in this version:

- **Live model list.** `Model = auto` asks the provider (`/models`) which models *your* key can use,
  then ranks them best-first: newest generation → flash → pro, with `flash-lite`/`mini` behind their
  bigger siblings, and preview/experimental models behind stable ones. Audio, live, TTS and embedding
  models are filtered out of the chat chain.
- **Automatic hand-over.** If a model fails, the same image is retried on the next model in the chain,
  inside the same run — no clicking, no re-uploading:
  - quota / `429` → the model cools down (`retryDelay` respected; a *daily* quota parks it for hours) and the next model answers,
  - retired, renamed or non-vision models → retired for the session and skipped from then on,
  - key rejected (`401`/`403`) → the next API key is used (paste several, separated by commas),
  - `400` on the request shape → one retry with a minimal body, then the next model,
  - network error / `5xx` → one quick retry, then the next model,
  - safety block, `MAX_TOKENS` cut-off or an empty answer → treated as a failure, not as a result.
- **You can see it happen.** The *Model fallback chain* panel lists every model with its live state
  (not tried / working ×n / cooling 4m / not available), a per-model **test** button, an activity log,
  and a **Reset status** button. Each finished image shows `via gemini-…`, the model that actually answered.
- **You can pin the order.** Put model names in the Model box (`gemini-2.5-flash, gemini-3.7-flash`) and
  they are tried first, in exactly that order; the rest of the chain stays behind them as backup.

The same engine drives every provider (Gemini, DeepSeek, OpenAI, Anthropic, OpenAI-compatible gateways) —
only the transport differs (Gemini `generateContent`, OpenAI `/chat/completions`, Anthropic `/messages`).

### Bengali / বাংলা

API key ছাড়া অ্যাপের কোনো কাজ নেই — key বসিয়ে Model ফিল্ডে `auto` রাখলেই হবে।

- Gemini-র যত মডেল আপনার key দিয়ে চলে, অ্যাপ নিজেই সব লিস্ট করে সবচেয়ে ভালোটা আগে ট্রাই করবে।
- একটা মডেল ফেল করলে (quota শেষ, মডেল বন্ধ, rate limit, ছবি পড়তে পারে না) সাথে সাথে পরের মডেল ধরে নেবে — একই ছবির জন্য, একই রানে; আপনাকে আবার কিছু চাপতে হবে না।
- একটার বেশি key থাকলে কমা দিয়ে বসান (`key1, key2`) — একটা reject হলে পরেরটা অটো ব্যবহার হবে।
- কোন মডেল কাজ করছে, কোনটা কুল-ডাউনে — সব *Model fallback chain* প্যানেলে দেখা যাবে; কোনো মডেলের পাশে **test** চেপে আলাদাভাবেও যাচাই করা যায়।
- Model ফিল্ডে নাম লিখে দিলে (`gemini-2.5-flash, gemini-3.7-flash`) ওগুলোই আগে try হবে, তারপর বাকি চেইন ব্যাকআপ হিসেবে থাকবে।

## Files

| file | what it is |
| --- | --- |
| `index.html` | the whole app: UI + rule engine + fallback engine (no build step) |
| `serve.mjs` | static server for local/preview use |
| `tests/fallback.test.mjs` | scripted-fetch tests for the chain: hand-over, cool-down, key rotation, discovery, ranking |
| `tests/ui.smoke.test.mjs` | loads the real page in jsdom, drops an image, clicks Generate, asserts the fallback happens visibly |
