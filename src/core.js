/* Monthly reconciliation preview. Newly authored code; no third-party runtime. */
/* global TextEncoder, module */
(function (root) {
  "use strict";
  const VERSION = "0.1.0-preview.20261009";
  function parseCSV(text) {
    const data = text.replace(/^\uFEFF/, "");
    const records = [];
    let fields = [],
      field = "",
      quoted = false,
      closed = false,
      line = 1,
      start = 1;
    const finish = () => {
      fields.push(field);
      records.push({ fields, line: start });
      fields = [];
      field = "";
      closed = false;
    };
    for (let i = 0; i < data.length; i++) {
      const c = data[i];
      if (quoted) {
        if (c === '"') {
          if (data[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            quoted = false;
            closed = true;
          }
        } else {
          field += c;
          if (c === "\n" || (c === "\r" && data[i + 1] !== "\n")) line++;
        }
      } else if (c === '"') {
        if (field || closed) throw Error("引用符の位置が不正です。元CSVを確認してください。");
        quoted = true;
      } else if (c === ",") {
        fields.push(field);
        field = "";
        closed = false;
      } else if (c === "\r" || c === "\n") {
        if (c === "\r" && data[i + 1] === "\n") i++;
        finish();
        line++;
        start = line;
      } else {
        if (closed) throw Error("引用符の後に区切り以外の文字があります。");
        field += c;
      }
    }
    if (quoted) throw Error("CSVの引用符が閉じていません。");
    if (field || fields.length || closed) finish();
    if (!records.length) throw Error("CSVが空です。");
    return records;
  }
  function dateValue(raw) {
    const text = String(raw).trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!m) return null;
    const y = +m[1],
      mo = +m[2],
      d = +m[3];
    const days = [
      31,
      y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28,
      31,
      30,
      31,
      30,
      31,
      31,
      30,
      31,
      30,
      31,
    ];
    return y >= 1900 && mo >= 1 && mo <= 12 && d >= 1 && d <= days[mo - 1] ? text : null;
  }
  function amountValue(raw) {
    const text = String(raw).trim();
    if (!/^[1-9]\d*$/.test(text)) return null;
    const n = Number(text);
    return Number.isSafeInteger(n) ? n : null;
  }
  function partyValue(raw, aliases = false) {
    let text = String(raw).normalize("NFKC").trim();
    if (aliases) text = text.replace(/^\(株\)\s*/, "株式会社");
    return text || null;
  }
  function readInput(text, side, filename) {
    if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > 1000000)
      throw Error("各CSVはUTF-8で1MB以内にしてください。");
    const records = parseCSV(text),
      header = records[0].fields;
    const standard = [
      "row_id",
      "invoice_date",
      "party",
      "gross_amount_jpy",
      "source_file",
      "source_row",
    ];
    const simple = ["日付", "相手先", "金額"];
    let mode;
    if (JSON.stringify(header) === JSON.stringify(standard)) mode = "standard";
    else if (JSON.stringify(header) === JSON.stringify(simple)) mode = "simple";
    else throw Error("列名は標準6列、または日付・相手先・金額の3列にしてください。");
    if (records.length < 2) throw Error("入力行がありません。");
    if (records.length > 301)
      throw Error("1ファイルは300行までです。分割して条件を記録してください。");
    const ids = new Set();
    return records.slice(1).map((record, index) => {
      if (record.fields.length !== header.length)
        throw Error(`${filename} の${record.line}行目で列数が合いません。空行も確認してください。`);
      const values = Object.fromEntries(header.map((key, i) => [key, record.fields[i]]));
      const id =
        mode === "standard"
          ? values.row_id
          : `${side === "ledger" ? "L" : "V"}${String(index + 1).padStart(3, "0")}`;
      if (!id || ids.has(id)) throw Error("行IDが空欄か重複しています。");
      ids.add(id);
      return {
        side,
        row_id: id,
        invoice_date: values.invoice_date ?? values["日付"],
        party: values.party ?? values["相手先"],
        gross_amount_jpy: values.gross_amount_jpy ?? values["金額"],
        source_file: filename,
        source_row: record.line,
        supplied_source_file: values.source_file ?? "",
        supplied_source_row: values.source_row ?? "",
        original_fields: record.fields.slice(),
      };
    });
  }
  function reconcile(ledger, invoices, options) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(options.period))
      throw Error("対象月をYYYY-MMで指定してください。");
    if (+options.period.slice(0, 4) < 1900) throw Error("対象年は1900年以降にしてください。");
    const all = [...ledger, ...invoices].map((row) => {
      const date = dateValue(row.invoice_date),
        amount = amountValue(row.gross_amount_jpy),
        party = partyValue(row.party, options.corporateAliases);
      const invalid = [];
      if (!date) invalid.push("日付が未記入または実在するYYYY-MM-DDではない");
      if (!party) invalid.push("相手先が未記入");
      if (amount === null) invalid.push("金額が正の整数円ではない");
      if (date && !date.startsWith(options.period + "-")) invalid.push("対象月の範囲外");
      return {
        ...row,
        normalized: { date, party, amount },
        invalid,
        classification: "review_required",
        reason: invalid.join("／"),
        paired_row_id: "",
      };
    });
    const sides = {
      ledger: all.filter((r) => r.side === "ledger"),
      invoices: all.filter((r) => r.side === "invoices"),
    };
    const key = (r) => JSON.stringify([r.normalized.date, r.normalized.party, r.normalized.amount]);
    const maps = { ledger: new Map(), invoices: new Map() };
    for (const row of all)
      if (!row.invalid.length) {
        const group = maps[row.side].get(key(row)) || [];
        group.push(row);
        maps[row.side].set(key(row), group);
      }
    const possible = (a, b) =>
      ["date", "party", "amount"].every(
        (k) =>
          a.normalized[k] === null ||
          b.normalized[k] === null ||
          a.normalized[k] === b.normalized[k],
      );
    for (const row of all) {
      if (row.invalid.length) continue;
      const other = row.side === "ledger" ? "invoices" : "ledger";
      const exact = maps[other].get(key(row)) || [],
        own = maps[row.side].get(key(row)) || [];
      const incompleteOther = sides[other].some((r) => r.invalid.length && possible(row, r));
      const incompleteOwn = sides[row.side].some(
        (r) => r !== row && r.invalid.length && possible(row, r),
      );
      if (exact.length === 1 && own.length === 1 && !incompleteOther && !incompleteOwn) {
        row.classification = "auto_map_candidate";
        row.paired_row_id = exact[0].row_id;
        row.reason = "対象月内・日付金額相手先一致・両方向で一意な1対1。人による確認前";
      } else if (exact.length > 1 || own.length > 1 || incompleteOther || incompleteOwn) {
        row.reason = "重複または欠損のある行からも対応できるため一意に特定できない";
      } else {
        const related = sides[other].some(
          (r) =>
            (r.normalized.party && r.normalized.party === row.normalized.party) ||
            (r.normalized.date === row.normalized.date &&
              r.normalized.amount !== null &&
              r.normalized.amount === row.normalized.amount),
        );
        row.classification = related ? "review_required" : "unmatched";
        row.reason = related
          ? "相手先・日付・金額の不一致、または分割・合算を確認する"
          : "対応する相手行が見つからない";
      }
    }
    return { version: VERSION, options: { ...options }, rows: all };
  }
  function recordReview(result, reviews, key, decision, reason, reviewer, timestamp) {
    if (!["accepted", "rejected", "pending"].includes(decision))
      throw Error("判断を選んでください。");
    if (!reason.trim() || !reviewer.trim()) throw Error("理由と匿名確認者IDを記入してください。");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(reviewer))
      throw Error("確認者IDは英数字・ハイフン・アンダースコアで記入してください。");
    if (
      typeof timestamp !== "string" ||
      !dateValue(timestamp.slice(0, 10)) ||
      !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
        timestamp,
      ) ||
      !Number.isFinite(Date.parse(timestamp))
    )
      throw Error("確認日時に実在する日付とタイムゾーンが必要です。");
    const row = result.rows.find((r) => `${r.side}:${r.row_id}` === key);
    if (!row) throw Error("対象行がありません。");
    const changes = [];
    const save = (r) => {
      const id = `${r.side}:${r.row_id}`;
      const after = {
        decision,
        reason: reason.trim(),
        reviewer_id: reviewer,
        reviewed_at: timestamp,
        paired_row_id: decision === "accepted" ? r.paired_row_id : "",
      };
      changes.push({ key: id, before: reviews[id] ? { ...reviews[id] } : null, after });
      reviews[id] = after;
    };
    if (decision === "accepted") {
      if (row.classification !== "auto_map_candidate")
        throw Error(
          "要確認・片側のみの行は自動候補として採用できません。未解決か候補不採用を記録してください。",
        );
      const partner = result.rows.find(
        (r) => r.side !== row.side && r.row_id === row.paired_row_id,
      );
      if (
        !partner ||
        partner.paired_row_id !== row.row_id ||
        partner.classification !== "auto_map_candidate"
      )
        throw Error("相互の対応が一致しません。");
      save(row);
      save(partner);
    } else {
      // A changed decision also invalidates the former reciprocal acceptance.
      const old = reviews[key];
      if (old?.decision === "accepted") {
        const partner = result.rows.find(
          (r) => r.side !== row.side && r.row_id === old.paired_row_id,
        );
        if (partner) save(partner);
      }
      save(row);
    }
    return changes;
  }
  function summary(result, reviews) {
    const counts = {
      input_rows: result.rows.length,
      candidate_rows: 0,
      review_rows: 0,
      unmatched_rows: 0,
      recorded_rows: 0,
      pending_rows: 0,
    };
    for (const r of result.rows) {
      counts[
        r.classification === "auto_map_candidate"
          ? "candidate_rows"
          : r.classification === "unmatched"
            ? "unmatched_rows"
            : "review_rows"
      ]++;
      const review = reviews[`${r.side}:${r.row_id}`];
      if (review) counts.recorded_rows++;
      if (!review || review.decision === "pending") counts.pending_rows++;
    }
    counts.record_complete =
      counts.input_rows > 0 &&
      counts.recorded_rows === counts.input_rows &&
      counts.pending_rows === 0;
    return counts;
  }
  function acceptUnreviewed(result, reviews, reason, reviewer, timestamp, confirmed) {
    if (confirmed !== true) throw Error("候補の両側を確認したことをチェックしてください。");
    const copy = { ...reviews },
      actions = [];
    for (const row of result.rows) {
      const key = `${row.side}:${row.row_id}`;
      if (
        row.side !== "ledger" ||
        row.classification !== "auto_map_candidate" ||
        copy[key] ||
        copy[`invoices:${row.paired_row_id}`]
      )
        continue;
      const changes = recordReview(result, copy, key, "accepted", reason, reviewer, timestamp);
      actions.push({ key, decision: "accepted", reason, reviewer, timestamp, changes });
    }
    Object.assign(reviews, copy);
    return actions;
  }
  function replayAudit(result, actions) {
    if (!Array.isArray(actions) || actions.length > 10000)
      throw Error("判断履歴の件数または形式が不正です。");
    const reviews = {};
    for (const item of actions) {
      const changes = recordReview(
        result,
        reviews,
        item.key,
        item.decision,
        item.reason,
        item.reviewer,
        item.timestamp,
      );
      if (JSON.stringify(changes) !== JSON.stringify(item.changes))
        throw Error("判断の変更前後と履歴が一致しません。");
    }
    return reviews;
  }
  function csvCell(value) {
    let text = String(value ?? "");
    // Spreadsheet formula guards deliberately cover leading C0 control characters.
    // eslint-disable-next-line no-control-regex
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }
  function checkpointJSON(
    result,
    sources,
    inputHashes,
    reviews,
    audit,
    savedAt = new Date().toISOString(),
  ) {
    if (!Array.isArray(audit) || audit.length > 10000)
      throw Error(
        "判断履歴は10000操作までです。直前の記録を保存し、試験担当者へ相談してください。",
      );
    const text = JSON.stringify(
      {
        schema_version: "1.0",
        version: VERSION,
        sources,
        input_hashes: inputHashes,
        options: result.options,
        rows: result.rows,
        reviews,
        audit,
        summary: summary(result, reviews),
        saved_at: savedAt,
        limits:
          "Hashes identify input bytes, not authenticity. Human entries and dates are not authenticated. This is a review record, not a completed monthly closing or tax return.",
      },
      null,
      2,
    );
    if (new TextEncoder().encode(text).byteLength > 4000000)
      throw Error(
        "この入力・判断では再開用JSONが4MBを超えます。入力を分割するか理由を短くしてください。記録は変更していません。",
      );
    return text;
  }
  function stageReviews(result, sources, inputHashes, reviews, audit, apply) {
    const nextReviews = { ...reviews };
    const actions = apply(nextReviews);
    const nextAudit = audit.concat(actions);
    checkpointJSON(result, sources, inputHashes, nextReviews, nextAudit);
    return { reviews: nextReviews, audit: nextAudit, actions };
  }
  function confirmationCSV(result, reviews) {
    const columns = [
      "side",
      "row_id",
      "source_file",
      "source_row",
      "paired_row_id",
      "decision",
      "reason",
      "reviewer_id",
      "reviewed_at",
    ];
    const lines = [columns.join(",")];
    for (const row of result.rows) {
      const review = reviews[`${row.side}:${row.row_id}`] || {};
      lines.push(
        columns
          .map((key) =>
            csvCell(
              key in review
                ? review[key]
                : ["side", "row_id", "source_file", "source_row"].includes(key)
                  ? row[key]
                  : "",
            ),
          )
          .join(","),
      );
    }
    return "\uFEFF" + lines.join("\r\n") + "\r\n";
  }
  const api = {
    VERSION,
    parseCSV,
    dateValue,
    amountValue,
    partyValue,
    readInput,
    reconcile,
    recordReview,
    acceptUnreviewed,
    replayAudit,
    summary,
    confirmationCSV,
    csvCell,
    checkpointJSON,
    stageReviews,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MonthlyReconcile = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
