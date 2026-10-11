/* global require, __dirname, TextEncoder, TextDecoder, Blob, Buffer */
/* eslint @typescript-eslint/no-require-imports: off -- This is a Node CommonJS test. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto, createHash } = require("node:crypto");
const core = require("../src/core.js");
const html = fs.readFileSync(path.join(__dirname, "../src/template.html"), "utf8");
const app = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");
const demo = Object.fromEntries(
  ["ledger", "invoices"].map((side) => [
    side,
    fs.readFileSync(
      path.join(__dirname, "../fixtures", `${side === "ledger" ? "ledger" : "invoices"}-standard.csv`),
      "utf8",
    ),
  ]),
);

// Event/DOM harness checks application state; it is not a browser or visual test.
function harness(cryptoProvider = webcrypto) {
  const ids = new Map(),
    downloads = [],
    blobs = new Map();
  let focused = null;
  class Element {
    constructor(id = "") {
      this.id = id;
      this.children = [];
      this.listeners = new Map();
      this.value = "";
      this.checked = false;
      this.disabled = false;
      this.hidden = false;
      this.options = new Map();
      this.content = "";
    }
    set textContent(value) {
      this.content = String(value);
      this.children = [];
    }
    get textContent() {
      return this.content + this.children.map((x) => x.textContent).join(" ");
    }
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }
    append(...children) {
      this.children.push(...children);
    }
    replaceChildren(...children) {
      this.children = [...children];
      this.content = "";
    }
    setAttribute(name, value) {
      this[name] = value;
    }
    querySelector(selector) {
      if (!this.options.has(selector)) this.options.set(selector, new Element());
      return this.options.get(selector);
    }
    focus() {
      focused = this.id;
    }
    scrollIntoView() {
      this.scrolled = true;
    }
    remove() {}
    click() {
      if (this.download) downloads.push({ name: this.download, blob: blobs.get(this.href) });
    }
    async dispatch(type) {
      if (!this.disabled) await this.listeners.get(type)?.({ target: this, preventDefault() {} });
    }
  }
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    assert.equal(ids.has(match[1]), false, `duplicate ID ${match[1]}`);
    const element = new Element(match[1]);
    element.hidden = /\bhidden\b/.test(match[0]);
    element.disabled = /\bdisabled\b/.test(match[0]);
    element.value = /\bvalue="([^"]*)"/.exec(match[0])?.[1] || "";
    ids.set(element.id, element);
  }
  ids.get("filter").value = "all";
  const document = {
    getElementById(id) {
      assert.ok(ids.has(id), id);
      return ids.get(id);
    },
    createElement() {
      return new Element();
    },
    body: new Element(),
  };
  const context = vm.createContext({
    MonthlyReconcile: core,
    SYNTHETIC_DEMO: demo,
    document,
    crypto: cryptoProvider,
    TextEncoder,
    TextDecoder,
    Blob,
    URL: {
      createObjectURL(blob) {
        const key = `blob:${blobs.size}`;
        blobs.set(key, blob);
        return key;
      },
      revokeObjectURL() {},
    },
    setTimeout() {},
    Date,
    JSON,
  });
  vm.runInContext(app, context);
  return {
    e: (id) => ids.get(id),
    downloads,
    focused: () => focused,
    snapshot: () =>
      JSON.parse(
        vm.runInContext("core.checkpointJSON(result,sources,inputHashes,reviews,audit)", context),
      ),
  };
}
async function openPair(h) {
  await h.e("demo").dispatch("click");
  h.e("reviewer").value = "AI_TEST";
  await h.e("reviewer").dispatch("input");
  await h.e("open-first").dispatch("click");
}
async function accept(h) {
  h.e("decision").value = "accepted";
  h.e("reason").value = "架空データによる操作試験";
  h.e("pair-confirm").checked = true;
  await h.e("review-form").dispatch("submit");
}
test("demo creates all candidates in one click and guides the user to a blank reviewer ID", async () => {
  const h = harness();
  await h.e("demo").dispatch("click");
  assert.match(h.e("counts").textContent, /入力 200行.*照合候補 80組/);
  assert.match(h.e("next-step").textContent, /OPERATOR/);
  assert.equal(h.e("reviewer").value, "");
  assert.equal(h.focused(), "reviewer");
  assert.equal(h.snapshot().summary.recorded_rows, 0);
});
test("missing ID directs focus without recording any review", async () => {
  const h = harness();
  await h.e("demo").dispatch("click");
  await h.e("open-first").dispatch("click");
  assert.equal(h.e("review-form").hidden, true);
  assert.equal(h.focused(), "reviewer");
  assert.equal(h.snapshot().audit.length, 0);
});
test("a pair displays both original sources with no preselected human decision", async () => {
  const h = harness();
  await openPair(h);
  assert.equal(h.e("pair-details").children.length, 2);
  assert.match(h.e("pair-details").textContent, /帳簿の元データ.*請求の元データ/);
  assert.match(h.e("pair-details").textContent, /ledger-standard.csv.*invoices-standard.csv/);
  assert.equal(h.e("decision").value, "");
  assert.equal(h.e("pair-confirm").checked, false);
  assert.equal(h.focused(), "decision");
  assert.equal(h.e("open-first").disabled, true);
});
test("acceptance requires an explicit decision, reason and confirmation before mutation", async () => {
  const h = harness();
  await openPair(h);
  await h.e("review-form").dispatch("submit");
  assert.equal(h.snapshot().audit.length, 0);
  h.e("decision").value = "accepted";
  h.e("reason").value = "架空の検査";
  await h.e("review-form").dispatch("submit");
  assert.equal(h.snapshot().audit.length, 0);
  h.e("pair-confirm").checked = true;
  h.e("reason").value = "";
  await h.e("review-form").dispatch("submit");
  assert.equal(h.snapshot().audit.length, 0);
  await accept(h);
  assert.equal(h.snapshot().summary.recorded_rows, 2);
  assert.equal(h.snapshot().summary.pending_rows, 198);
  assert.equal(h.e("review-form").hidden, true);
  assert.equal(h.focused(), "save-json");
});
test("JSON/CSV downloads retain the same records and show which export is still missing", async () => {
  const h = harness();
  await openPair(h);
  await accept(h);
  await h.e("save-json").dispatch("click");
  assert.match(h.e("save-status").textContent, /次にCSV/);
  await h.e("save-csv").dispatch("click");
  assert.match(h.e("save-status").textContent, /両方のファイル/);
  assert.equal(h.downloads.length, 2);
  const saved = JSON.parse(await h.downloads[0].blob.text());
  const csv = Buffer.from(await h.downloads[1].blob.arrayBuffer()).toString("utf8");
  assert.equal(saved.summary.recorded_rows, 2);
  assert.equal(saved.summary.pending_rows, 198);
  assert.equal(csv, core.confirmationCSV({ rows: saved.rows }, saved.reviews));
});
test("cancel preserves all inputs, review history and recorded values", async () => {
  const h = harness();
  await openPair(h);
  const before = h.snapshot();
  h.e("reason").value = "not recorded";
  await h.e("review-cancel").dispatch("click");
  const after = h.snapshot();
  delete before.saved_at;
  delete after.saved_at;
  assert.deepEqual(after, before);
  assert.equal(h.e("open-first").disabled, false);
});
test("saved pre-guide format reopens with the same rows and judgments", async () => {
  const sources = {
    ledger: { text: demo.ledger, name: "ledger-standard.csv" },
    invoices: { text: demo.invoices, name: "invoices-standard.csv" },
  };
  const hashes = Object.fromEntries(
    Object.entries(sources).map(([k, v]) => [k, createHash("sha256").update(v.text).digest("hex")]),
  );
  const result = core.reconcile(
    core.readInput(demo.ledger, "ledger", sources.ledger.name),
    core.readInput(demo.invoices, "invoices", sources.invoices.name),
    { period: "2026-09", corporateAliases: true },
  );
  const reviews = {},
    action = {
      key: "ledger:L001",
      decision: "accepted",
      reason: "synthetic old record",
      reviewer: "AI_TEST",
      timestamp: "2026-10-09T10:00:00+09:00",
    };
  action.changes = core.recordReview(
    result,
    reviews,
    action.key,
    action.decision,
    action.reason,
    action.reviewer,
    action.timestamp,
  );
  const text = core.checkpointJSON(result, sources, hashes, reviews, [action]);
  const h = harness();
  h.e("resume").files = [{ size: Buffer.byteLength(text), text: async () => text }];
  await h.e("resume").dispatch("change");
  assert.equal(h.snapshot().summary.recorded_rows, 2);
  assert.deepEqual(h.snapshot().reviews, reviews);
  assert.equal(h.e("reviewer").value, "");
  assert.equal(h.snapshot().audit.length, 1);
});
test("controls and pair form precede the 200-row table in the HTML", () => {
  assert.ok(html.indexOf('id="review-form"') < html.indexOf('id="rows"'));
  assert.ok(html.indexOf('id="save-json"') < html.indexOf('id="rows"'));
  assert.ok(html.indexOf('id="reviewer"') < html.indexOf('id="review-form"'));
});


test("delayed JSON resume disables demo and input edits before reading the file", async () => {
  const seed = harness();
  await seed.e("demo").dispatch("click");
  const text = JSON.stringify(seed.snapshot());
  const h = harness();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  h.e("resume").files = [{ size: Buffer.byteLength(text), text: () => gate }];
  const pending = h.e("resume").dispatch("change");
  const locked = ["demo", "run", "ledger", "invoices", "ledger-file", "invoices-file", "resume"].every((id) => h.e(id).disabled);
  release(text);
  await pending;
  assert.equal(locked, true, "JSON verification must prevent a new run from replacing in-flight work");
  assert.equal(h.snapshot().summary.input_rows, 200);
  assert.equal(h.e("resume").disabled, false);
});

test("two queued JSON resumes preserve the first verified review history", async () => {
  const withReviews = harness();
  await openPair(withReviews);
  await accept(withReviews);
  const firstText = JSON.stringify(withReviews.snapshot());
  const empty = harness();
  await empty.e("demo").dispatch("click");
  const secondText = JSON.stringify(empty.snapshot());
  const h = harness();
  let firstRelease, secondRelease;
  const firstGate = new Promise((resolve) => { firstRelease = resolve; });
  const secondGate = new Promise((resolve) => { secondRelease = resolve; });
  h.e("resume").files = [{ size: Buffer.byteLength(firstText), text: () => firstGate }];
  const first = h.e("resume").dispatch("change");
  h.e("resume").files = [{ size: Buffer.byteLength(secondText), text: () => secondGate }];
  // Simulate a second already queued change event; disabled controls alone are not the guard.
  const second = h.e("resume").listeners.get("change")({ target: h.e("resume") });
  firstRelease(firstText);
  await first;
  secondRelease(secondText);
  await second;
  assert.equal(h.snapshot().summary.recorded_rows, 2, "second import must not erase the first review");
  assert.equal(h.snapshot().audit.length, 1);
});

test("invalid resumed JSON releases controls and permits another valid import", async () => {
  const h = harness();
  h.e("resume").files = [{ size: 1, text: async () => "{" }];
  await h.e("resume").dispatch("change");
  for (const id of ["demo", "run", "ledger", "invoices", "resume"]) assert.equal(h.e(id).disabled, false);
  assert.equal(h.e("save-json").disabled, true);
  const seed = harness();
  await openPair(seed);
  await accept(seed);
  const text = JSON.stringify(seed.snapshot());
  h.e("resume").files = [{ size: Buffer.byteLength(text), text: async () => text }];
  await h.e("resume").dispatch("change");
  assert.equal(h.snapshot().summary.recorded_rows, 2);
  assert.equal(h.snapshot().audit.length, 1);
});


test("CSV reading disables competing edits and a second queued selection", async () => {
  const h = harness();
  let finish;
  const first = new Promise((resolve) => { finish = resolve; });
  h.e("ledger-file").files = [{ size: 5, name: "first.csv", arrayBuffer: () => first }];
  const running = h.e("ledger-file").dispatch("change");
  const locked = ["ledger-file", "ledger", "demo", "resume"].map((id) => h.e(id).disabled);
  const later = { size: 6, name: "later.csv", arrayBuffer: async () => Buffer.from("later") };
  h.e("ledger-file").files = [later];
  await h.e("ledger-file").listeners.get("change")({ target: h.e("ledger-file") });
  const stillLocked = h.e("ledger-file").disabled;
  finish(Buffer.from("first"));
  await running;
  assert.equal(h.e("ledger").value, "first");
  assert.equal(h.e("ledger-name").value, "first.csv");
  assert.deepEqual(locked, [true, true, true, true]);
  assert.equal(stillLocked, true);
  assert.equal(h.e("ledger-file").disabled, false);
  assert.equal(h.e("ledger-file").value, "");
});

test("failed CSV reading unlocks controls and allows the same file to be retried", async () => {
  const h = harness();
  h.e("ledger").value = "keep";
  h.e("ledger-file").value = "same.csv";
  h.e("ledger-file").files = [{ size: 1, name: "same.csv", arrayBuffer: async () => Buffer.from([255]) }];
  await h.e("ledger-file").dispatch("change");
  assert.equal(h.e("ledger").value, "keep");
  assert.equal(h.e("ledger-file").value, "");
  assert.equal(h.e("run").disabled, false);
  assert.equal(h.e("resume").disabled, false);
  h.e("ledger-file").files = [{ size: 2, name: "same.csv", arrayBuffer: async () => Buffer.from("ok") }];
  await h.e("ledger-file").dispatch("change");
  assert.equal(h.e("ledger").value, "ok");
});

test("pending input hashes keep reset and exports disabled until a result exists", async () => {
  let finish;
  const first = new Promise((resolve) => { finish = resolve; });
  let calls = 0;
  const cryptoProvider = { subtle: { digest: async (...args) => {
    if (++calls === 1) await first;
    return webcrypto.subtle.digest(...args);
  } } };
  const h = harness(cryptoProvider);
  const running = h.e("demo").dispatch("click");
  assert.equal(h.e("reset").disabled, true);
  assert.equal(h.e("save-json").disabled, true);
  assert.equal(h.e("save-csv").disabled, true);
  assert.equal(h.e("resume").disabled, true);
  await h.e("reset").dispatch("click");
  assert.equal(h.e("reset-panel").hidden, true);
  finish();
  await running;
  assert.equal(h.snapshot().summary.input_rows, 200);
  assert.equal(h.e("reset").disabled, false);
  assert.equal(h.e("save-json").disabled, false);
});


test("CSV import does not temporarily apply a second file while the first is pending", async () => {
  const h = harness();
  let finish;
  const first = new Promise((resolve) => { finish = resolve; });
  h.e("ledger-file").files = [{ size: 5, name: "first.csv", arrayBuffer: () => first }];
  const running = h.e("ledger-file").dispatch("change");
  h.e("ledger-file").files = [{ size: 6, name: "later.csv", arrayBuffer: async () => Buffer.from("later") }];
  await h.e("ledger-file").dispatch("change");
  const interim = h.e("ledger").value;
  finish(Buffer.from("first"));
  await running;
  assert.equal(interim, "", "a competing selection was applied before the first read completed");
  assert.equal(h.e("ledger").value, "first");
});
