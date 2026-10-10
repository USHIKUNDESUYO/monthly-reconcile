/* global require, __dirname, TextEncoder */
/* eslint @typescript-eslint/no-require-imports: off -- This is a Node CommonJS test. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../src/core.js");
const kit = path.join(__dirname, "../fixtures");
const load = (name, side) =>
  core.readInput(fs.readFileSync(path.join(kit, name), "utf8"), side, name);
const fixture = () =>
  core.reconcile(load("ledger-standard.csv", "ledger"), load("invoices-standard.csv", "invoices"), {
    period: "2026-09",
    corporateAliases: true,
  });
const input = (rows, side = "ledger") =>
  core.readInput("日付,相手先,金額\n" + rows.join("\n") + "\n", side, side + ".csv");
const calculate = (a, b, options = {}) =>
  core.reconcile(input(a), input(b, "invoices"), {
    period: "2026-09",
    corporateAliases: false,
    ...options,
  });
const timestamp = "2026-10-09T10:00:00+09:00";

for (const newline of ["\r", "\r\n", "\n"]) {
  test(`quoted ${JSON.stringify(newline)} line breaks retain physical source references`, () => {
    const text =
      "日付,相手先,金額" +
      newline +
      '2026-09-01,"架空' +
      newline +
      '会社",100' +
      newline +
      "2026-09-02,架空B,200" +
      newline;
    const rows = core.readInput(text, "ledger", "synthetic.csv");
    assert.deepEqual(
      rows.map((row) => row.source_row),
      [2, 4],
    );
    assert.equal(rows[0].party, "架空" + newline + "会社");
    assert.equal(rows[1].source_file, "synthetic.csv");
  });
}

const checkpointInputs = () => ({
  ledger: {
    text: fs.readFileSync(path.join(kit, "ledger-standard.csv"), "utf8"),
    name: "ledger-standard.csv",
  },
  invoices: {
    text: fs.readFileSync(path.join(kit, "invoices-standard.csv"), "utf8"),
    name: "invoices-standard.csv",
  },
});
test("oversized bulk review keeps the original reviews and audit saveable", () => {
  const result = fixture(),
    reviews = {},
    audit = [],
    sources = checkpointInputs();
  const action = {
    key: "ledger:L001",
    decision: "accepted",
    reason: "原資料の両側を確認",
    reviewer: "AI_TEST",
    timestamp,
  };
  action.changes = core.recordReview(
    result,
    reviews,
    action.key,
    action.decision,
    action.reason,
    action.reviewer,
    timestamp,
  );
  audit.push(action);
  const before = JSON.stringify({ reviews, audit });
  assert.throws(
    () =>
      core.stageReviews(result, sources, {}, reviews, audit, (copy) =>
        core.acceptUnreviewed(result, copy, "架空試験".repeat(2500), "AI_TEST", timestamp, true),
      ),
    /4MB/,
  );
  assert.equal(JSON.stringify({ reviews, audit }), before);
  const saved = JSON.parse(core.checkpointJSON(result, sources, {}, reviews, audit, timestamp));
  assert.deepEqual(core.replayAudit(result, saved.audit), saved.reviews);
  assert.equal(saved.summary.recorded_rows, 2);
});
test("an oversized individual revision preserves both sides of an accepted pair", () => {
  const result = fixture(),
    sources = checkpointInputs(),
    reviews = {},
    audit = [];
  const first = core.stageReviews(result, sources, {}, reviews, audit, (copy) => {
    const action = {
      key: "ledger:L001",
      decision: "accepted",
      reason: "原資料を確認",
      reviewer: "AI_TEST",
      timestamp,
    };
    return [
      {
        ...action,
        changes: core.recordReview(
          result,
          copy,
          action.key,
          action.decision,
          action.reason,
          action.reviewer,
          timestamp,
        ),
      },
    ];
  });
  const before = JSON.stringify(first);
  assert.throws(
    () =>
      core.stageReviews(result, sources, {}, first.reviews, first.audit, (copy) => {
        const action = {
          key: "ledger:L001",
          decision: "pending",
          reason: "架".repeat(750000),
          reviewer: "AI_TEST",
          timestamp,
        };
        return [
          {
            ...action,
            changes: core.recordReview(
              result,
              copy,
              action.key,
              action.decision,
              action.reason,
              action.reviewer,
              timestamp,
            ),
          },
        ];
      }),
    /4MB/,
  );
  assert.equal(JSON.stringify(first), before);
  assert.equal(first.reviews["invoices:V001"].decision, "accepted");
});
test("small source files that expand beyond the checkpoint limit cannot start an unsaveable record", () => {
  const text = "日付,相手先,金額\n2026-09-01," + "㈱".repeat(160000) + ",100\n";
  assert.ok(new TextEncoder().encode(text).byteLength < 1000000);
  const result = core.reconcile(
    core.readInput(text, "ledger", "a.csv"),
    core.readInput(text, "invoices", "b.csv"),
    { period: "2026-09", corporateAliases: false },
  );
  assert.throws(
    () =>
      core.checkpointJSON(
        result,
        { ledger: { text, name: "a.csv" }, invoices: { text, name: "b.csv" } },
        {},
        {},
        [],
      ),
    /4MB/,
  );
});
test("checkpoint limit agrees with the resume history count limit", () => {
  assert.throws(
    () => core.checkpointJSON(fixture(), checkpointInputs(), {}, {}, Array(10001).fill({})),
    /10000/,
  );
});

test("CSV limit applies to UTF-8 bytes even when pasted characters are under one million", () => {
  const text = "日付,相手先,金額\n2026-09-01," + "架".repeat(340000) + ",100\n";
  assert.ok(text.length < 1000000);
  assert.throws(() => core.readInput(text, "ledger", "large.csv"), /1MB/);
});

test("all 200 fixture classifications match proposed expectations; every row retained", () => {
  const result = fixture(),
    expected = JSON.parse(fs.readFileSync(path.join(kit, "expected.json"), "utf8"));
  assert.equal(result.rows.length, 200);
  for (const entry of expected.rows) {
    const row = result.rows.find((r) => r.side === entry.side && r.row_id === entry.row_id);
    assert.equal(row.classification, entry.classification, entry.row_id);
    if (row.classification === "auto_map_candidate") {
      const other = result.rows.find((r) => r.side !== row.side && r.row_id === row.paired_row_id);
      assert.equal(other.paired_row_id, row.row_id);
    }
  }
  assert.deepEqual(core.summary(result, {}), {
    input_rows: 200,
    candidate_rows: 160,
    review_rows: 38,
    unmatched_rows: 2,
    recorded_rows: 0,
    pending_rows: 200,
    record_complete: false,
  });
});
test("same date and amount with different party is never a candidate", () => {
  const result = calculate(["2026-09-01,Alpha,100"], ["2026-09-01,Beta,100"]);
  assert.ok(result.rows.every((r) => r.classification === "review_required"));
});
test("leap years and invalid calendar dates are checked without date normalization", () => {
  assert.equal(core.dateValue("2026-02-30"), null);
  assert.equal(core.dateValue("1900-02-29"), null);
  assert.equal(core.dateValue("2000-02-29"), "2000-02-29");
  assert.equal(core.dateValue("2026-9-01"), null);
});
test("missing, zero, negative, fractional, scientific notation and unsafe amounts excluded", () => {
  for (const text of ["", "0", "-100", "1.5", "1e3", "1,000", "9007199254740992"])
    assert.equal(core.amountValue(text), null, text);
  assert.equal(core.amountValue("100"), 100);
});
test("duplicate on either side excludes both-direction automatic mapping", () => {
  for (const sides of [
    [["2026-09-01,A,100", "2026-09-01,A,100"], ["2026-09-01,A,100"]],
    [["2026-09-01,A,100"], ["2026-09-01,A,100", "2026-09-01,A,100"]],
  ]) {
    assert.ok(calculate(...sides).rows.every((r) => r.classification === "review_required"));
  }
});
test("a missing field that could be another partner blocks an otherwise exact candidate", () => {
  const result = calculate(["2026-09-01,A,100"], ["2026-09-01,A,100", ",A,100"]);
  assert.ok(result.rows.every((r) => r.classification === "review_required"));
});
test("out-of-month and invalid-date counterpart cannot be automatically accepted", () => {
  for (const date of ["2026-08-01", "2026-02-30"]) {
    assert.ok(
      calculate(["2026-09-01,A,100"], [`${date},A,100`]).rows.every(
        (r) => r.classification === "review_required",
      ),
    );
  }
});
test("corporate notation is opt-in and internal whitespace or different company is not guessed", () => {
  assert.notEqual(core.partyValue("株式会社 A"), core.partyValue("㈱ A"));
  assert.equal(core.partyValue("㈱ A", true), "株式会社A");
  assert.notEqual(core.partyValue("A B", true), core.partyValue("AB", true));
  assert.notEqual(core.partyValue("株式会社A", true), core.partyValue("株式会社B", true));
});
test("CSV supports quoted commas, quotes, multiline fields and physical source rows", () => {
  const rows = core.readInput(
    '日付,相手先,金額\r\n2026-09-01,"A, ""B""\nC",100\r\n2026-09-02,D,200\r\n',
    "ledger",
    "source.csv",
  );
  assert.equal(rows[0].party, 'A, "B"\nC');
  assert.equal(rows[0].source_row, 2);
  assert.equal(rows[1].source_row, 4);
});
test("bad CSV, unexpected header and blank data lines fail rather than dropping rows", () => {
  for (const csv of [
    '日付,相手先,金額\n2026-09-01,"A,100',
    "date,party,amount\n2026-09-01,A,100",
    "日付,相手先,金額\n2026-09-01,A,100\n\n",
    '日付,相手先,金額\n2026-09-01,"A"bad,100',
  ]) {
    assert.throws(() => core.readInput(csv, "ledger", "a.csv"));
  }
});
test("duplicated row IDs and more than 300 rows are rejected", () => {
  const csv =
    "row_id,invoice_date,party,gross_amount_jpy,source_file,source_row\nA,2026-09-01,X,100,x,2\nA,2026-09-02,Y,200,x,3";
  assert.throws(() => core.readInput(csv, "ledger", "x.csv"));
  assert.throws(() => input(Array(301).fill("2026-09-01,A,100")));
});
test("human acceptance records reciprocal reviewer, time, reason and original row values", () => {
  const result = fixture(),
    reviews = {};
  const changes = core.recordReview(
    result,
    reviews,
    "ledger:L001",
    "accepted",
    "両原資料を確認した",
    "P001",
    timestamp,
  );
  assert.equal(changes.length, 2);
  assert.equal(reviews["invoices:V001"].paired_row_id, "L001");
  assert.equal(reviews["ledger:L001"].reviewed_at, timestamp);
  assert.equal(result.rows[0].gross_amount_jpy, "10000");
  assert.equal(core.summary(result, reviews).pending_rows, 198);
});
test("revising accepted row invalidates counterpart; history contains previous values", () => {
  const result = fixture(),
    reviews = {};
  core.recordReview(
    result,
    reviews,
    "ledger:L001",
    "accepted",
    "両原資料を確認した",
    "P001",
    timestamp,
  );
  const changes = core.recordReview(
    result,
    reviews,
    "ledger:L001",
    "pending",
    "追加資料が必要",
    "P002",
    timestamp,
  );
  assert.ok(
    changes.every((c) => c.before.decision === "accepted" && c.after.decision === "pending"),
  );
  assert.equal(core.summary(result, reviews).pending_rows, 200);
});
test("review-required rows cannot be accepted and missing human fields are rejected", () => {
  const result = fixture();
  assert.throws(() =>
    core.recordReview(result, {}, "ledger:L081", "accepted", "理由", "P001", timestamp),
  );
  for (const params of [
    ["", "P001", timestamp],
    ["理由", "", timestamp],
    ["理由", "P001", "2026-02-30T10:00:00Z"],
    ["理由", "P001", "2026-10-09T10:00:00"],
  ]) {
    assert.throws(() => core.recordReview(result, {}, "ledger:L001", "accepted", ...params));
  }
});
test("bulk acceptance requires confirmation and does not overwrite rejected or unresolved decisions", () => {
  const result = fixture(),
    reviews = {};
  core.recordReview(
    result,
    reviews,
    "ledger:L001",
    "rejected",
    "候補を使わない根拠",
    "P001",
    timestamp,
  );
  assert.throws(() => core.acceptUnreviewed(result, reviews, "確認理由", "P001", timestamp, false));
  const actions = core.acceptUnreviewed(
    result,
    reviews,
    "両原資料を確認した",
    "P001",
    timestamp,
    true,
  );
  assert.equal(actions.length, 79);
  assert.equal(reviews["ledger:L001"].decision, "rejected");
  assert.equal(core.summary(result, reviews).pending_rows, 41);
  assert.equal(core.summary(result, reviews).record_complete, false);
});
test("CSV exports all rows, retains unresolved blanks, and escapes formula prefixes", () => {
  const result = fixture();
  const output = core.confirmationCSV(result, {});
  assert.equal(core.parseCSV(output).length, 201);
  assert.match(core.csvCell('=HYPERLINK("bad")'), /^"'/);
  assert.match(core.csvCell(" \t@SUM(1)"), /^"'/);
  assert.equal(core.parseCSV(output)[1].fields[2], "ledger-standard.csv");
});
test("input changes and period options produce fresh classifications instead of stale acceptance", () => {
  const result = calculate(["2026-09-01,A,100"], ["2026-09-01,A,100"]);
  assert.equal(result.rows[0].classification, "auto_map_candidate");
  assert.ok(
    calculate(["2026-09-01,A,100"], ["2026-09-01,A,100"], { period: "2026-10" }).rows.every(
      (r) => r.classification === "review_required",
    ),
  );
});
test("replay validates previous and new values, rejecting altered history even if final reviews look correct", () => {
  const result = fixture(),
    reviews = {};
  const actions = core.acceptUnreviewed(
    result,
    reviews,
    "架空データによる操作検査",
    "AI_TEST",
    timestamp,
    true,
  );
  assert.deepEqual(core.replayAudit(result, actions), reviews);
  const tampered = JSON.parse(JSON.stringify(actions));
  tampered[0].changes[0].before = { decision: "accepted", reason: "tampered" };
  assert.throws(() => core.replayAudit(result, tampered), /変更前後/);
});
