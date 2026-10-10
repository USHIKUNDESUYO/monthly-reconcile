/* global MonthlyReconcile, SYNTHETIC_DEMO, document, crypto, TextEncoder, TextDecoder, URL, Blob, setTimeout */
"use strict";
const core = MonthlyReconcile;
const el = (id) => document.getElementById(id);
let result = null,
  reviews = {},
  audit = [],
  sources = null,
  inputHashes = null,
  chosen = null,
  processing = false;
let savedExports = { json: false, csv: false };
const showError = (error) => {
  el("message").textContent = error.message || String(error);
  el("message").className = "notice error";
};
async function hash(text) {
  if (!globalThis.crypto?.subtle)
    throw Error(
      "このブラウザーでは入力ハッシュを作成できません。ChromeまたはEdgeで開いてください。",
    );
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buffer)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function lock(locked) {
  for (const id of [
    "ledger",
    "invoices",
    "ledger-name",
    "invoices-name",
    "period",
    "aliases",
    "ledger-file",
    "invoices-file",
    "demo",
    "run",
  ])
    el(id).disabled = locked;
  for (const id of ["save-json", "save-csv", "reset"]) el(id).disabled = !locked;
}
function render() {
  const s = core.summary(result, reviews);
  el("counts").textContent =
    `入力 ${s.input_rows}行 ／ 照合候補 ${s.candidate_rows / 2}組 ／ 要確認 ${s.review_rows}行 ／ 片側のみ ${s.unmatched_rows}行`;
  el("progress").textContent =
    `記入 ${s.recorded_rows}行 ／ 未記入・未解決 ${s.pending_rows}行。${s.record_complete ? "全行の判断記録が揃いました。会計判断の正しさや月次決算の完了は別途確認してください。" : "確認待ちがあります。全件完了として扱わないでください。"}`;
  const body = el("rows");
  body.replaceChildren();
  const labels = {
    auto_map_candidate: "照合候補",
    review_required: "要確認",
    unmatched: "片側のみ",
  };
  const decisions = { accepted: "採用", rejected: "候補不採用", pending: "未解決" };
  const filtered = result.rows.filter(
    (row) =>
      el("filter").value !== "pending" ||
      !reviews[`${row.side}:${row.row_id}`] ||
      reviews[`${row.side}:${row.row_id}`].decision === "pending",
  );
  for (const row of filtered) {
    const key = `${row.side}:${row.row_id}`,
      review = reviews[key],
      tr = document.createElement("tr");
    tr.className = row.classification === "auto_map_candidate" ? "" : "attention";
    const values = [
      row.side === "ledger" ? "帳簿" : "請求",
      row.row_id,
      `${row.source_file} ${row.source_row}行`,
      row.invoice_date,
      row.party,
      row.gross_amount_jpy,
      labels[row.classification],
      row.paired_row_id || "—",
      review ? decisions[review.decision] : "未記入",
    ];
    for (const value of values) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.append(td);
    }
    const td = document.createElement("td"),
      button = document.createElement("button");
    button.type = "button";
    button.textContent = "確認";
    button.setAttribute("aria-label", `${values[0]} ${row.row_id} を確認`);
    button.addEventListener("click", () => selectRow(row));
    td.append(button);
    tr.append(td);
    body.append(tr);
  }
  el("shown").textContent = `${filtered.length}行を表示中`;
  renderGuide();
}
function renderGuide() {
  if (!result) return;
  const s = core.summary(result, reviews);
  const next = result.rows.find(
    (row) => row.classification === "auto_map_candidate" && !reviews[`${row.side}:${row.row_id}`],
  );
  el("open-first").disabled = !next || !el("review-form").hidden;
  el("next-step").textContent = !el("reviewer").value.trim()
    ? "まず、下の確認者IDにOPERATORと入力してください。"
    : !el("review-form").hidden
      ? "両側の元データを確認し、判断と理由を選んで「この判断を記録する」を押してください。"
      : s.recorded_rows === 0
        ? next
          ? "次に「2 未記入の候補を1組確認する」を押してください。"
          : "照合候補がありません。下の一覧から要確認の行を開いてください。"
        : "判断を記録しました。次は、下のJSONとCSVをそれぞれ保存してください。";
  el("save-status").textContent =
    savedExports.json && savedExports.csv
      ? "JSONとCSVの保存を開始しました。ダウンロード先で両方のファイルを確認してから、別のタブでJSONを再開してください。"
      : savedExports.json
        ? "JSONの保存を開始しました。次にCSVも保存してください。"
        : savedExports.csv
          ? "CSVの保存を開始しました。次にJSONも保存してください。"
          : s.recorded_rows === 0
            ? "今は判断が0行です。保存しても、確認済みの記録は入りません。"
            : `判断を記録した${s.recorded_rows}行と、残る未記入・未解決${s.pending_rows}行を両方のファイルに保存します。`;
}
function renderPair(row) {
  const box = el("pair-details");
  box.replaceChildren();
  const partner = result.rows.find(
    (other) => other.side !== row.side && other.row_id === row.paired_row_id,
  );
  for (const item of partner ? [row, partner].sort((a) => (a.side === "ledger" ? -1 : 1)) : [row]) {
    const card = document.createElement("div"),
      heading = document.createElement("h3"),
      list = document.createElement("dl");
    card.className = "pair-card";
    heading.textContent = item.side === "ledger" ? "帳簿の元データ" : "請求の元データ";
    card.append(heading, list);
    for (const [label, value] of [
      ["行ID", item.row_id],
      ["元の行", `${item.source_file} ${item.source_row}行`],
      ["日付", item.invoice_date],
      ["相手先", item.party],
      ["金額", `${item.gross_amount_jpy}円`],
    ]) {
      const term = document.createElement("dt"),
        description = document.createElement("dd");
      term.textContent = label;
      description.textContent = value;
      list.append(term, description);
    }
    box.append(card);
  }
}
function selectRow(row) {
  if (!el("reviewer").value.trim()) {
    showError(Error("先に確認者IDを入力してください。起動確認ではOPERATORを使えます。"));
    el("reviewer").focus();
    return;
  }
  chosen = `${row.side}:${row.row_id}`;
  const review = reviews[chosen];
  el("selected").textContent =
    `${row.side === "ledger" ? "帳簿" : "請求"} ${row.row_id} ／ ${row.source_file} ${row.source_row}行`;
  el("basis").textContent = row.reason;
  el("decision").value = review?.decision || "";
  el("reason").value = review?.reason || "";
  el("decision").querySelector('option[value="accepted"]').disabled =
    row.classification !== "auto_map_candidate";
  el("review-form").hidden = false;
  el("pair-confirm").checked = false;
  el("pair-confirm").disabled = row.classification !== "auto_map_candidate";
  renderPair(row);
  el("review-form").scrollIntoView({ behavior: "smooth", block: "start" });
  el("decision").focus({ preventScroll: true });
  el("message").textContent = "両側の元データを表示しました。確認してから判断を記録してください。";
  el("message").className = "notice";
  renderGuide();
}
function download(name, text, type, kind) {
  const url = URL.createObjectURL(new Blob([text], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  el("message").textContent =
    "保存を開始しました。ブラウザーのダウンロード先でファイルを確認してください。";
  el("message").className = "notice";
  savedExports[kind] = true;
  renderGuide();
}
async function run() {
  try {
    processing = true;
    el("run").disabled = true;
    const input = {
      ledger: { text: el("ledger").value, name: el("ledger-name").value },
      invoices: { text: el("invoices").value, name: el("invoices-name").value },
    };
    for (const item of Object.values(input))
      if (!item.name.trim() || item.text.length > 1000000)
        throw Error("入力名を記入し、各CSVは1MB以内にしてください。");
    const options = { period: el("period").value, corporateAliases: el("aliases").checked };
    const calculation = core.reconcile(
      core.readInput(input.ledger.text, "ledger", input.ledger.name),
      core.readInput(input.invoices.text, "invoices", input.invoices.name),
      options,
    );
    lock(true);
    const hashes = {
      ledger: await hash(input.ledger.text),
      invoices: await hash(input.invoices.text),
    };
    core.checkpointJSON(calculation, input, hashes, {}, []);
    result = calculation;
    sources = input;
    inputHashes = hashes;
    reviews = {};
    audit = [];
    savedExports = { json: false, csv: false };
    el("results").hidden = false;
    el("review-form").hidden = true;
    el("message").textContent = "候補を作成しました。各行の根拠を確認し、判断を記入してください。";
    el("message").className = "notice";
    render();
    el("results").scrollIntoView({ behavior: "smooth", block: "start" });
    el("reviewer").focus({ preventScroll: true });
  } catch (error) {
    if (!result) lock(false);
    showError(error);
  } finally {
    processing = false;
  }
}
el("run").addEventListener("click", run);
el("demo").addEventListener("click", async () => {
  el("ledger").value = SYNTHETIC_DEMO.ledger;
  el("invoices").value = SYNTHETIC_DEMO.invoices;
  el("ledger-name").value = "ledger-standard.csv";
  el("invoices-name").value = "invoices-standard.csv";
  el("period").value = "2026-09";
  el("aliases").checked = true;
  await run();
});
el("reviewer").addEventListener("input", renderGuide);
el("open-first").addEventListener("click", () => {
  if (!result) return;
  const row = result.rows.find(
    (item) =>
      item.classification === "auto_map_candidate" && !reviews[`${item.side}:${item.row_id}`],
  );
  if (row) selectRow(row);
});
el("review-cancel").addEventListener("click", () => {
  chosen = null;
  el("review-form").hidden = true;
  renderGuide();
});
for (const side of ["ledger", "invoices"])
  el(`${side}-file`).addEventListener("change", async (event) => {
    try {
      const file = event.target.files[0];
      if (!file) return;
      if (file.size > 1000000) throw Error("CSVは1MB以内にしてください。");
      const bytes = await file.arrayBuffer();
      if (result || processing)
        throw Error("処理を終え、先に保存して入力を変更するボタンを押してください。");
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      el(side).value = text;
      el(`${side}-name`).value = file.name;
      el("message").textContent = "CSVを端末内で読み込みました。対象月を確認してください。";
    } catch (error) {
      showError(error);
    }
  });
el("review-form").addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    if (!["accepted", "rejected", "pending"].includes(el("decision").value))
      throw Error("判断を選んでください。採用・候補不採用・未解決から選べます。");
    if (el("decision").value === "accepted" && !el("pair-confirm").checked)
      throw Error("両側の元データを確認し、確認したチェックを入れてください。");
    const action = {
      key: chosen,
      decision: el("decision").value,
      reason: el("reason").value,
      reviewer: el("reviewer").value,
      timestamp: new Date().toISOString(),
    };
    const next = core.stageReviews(result, sources, inputHashes, reviews, audit, (copy) => {
      const changes = core.recordReview(
        result,
        copy,
        action.key,
        action.decision,
        action.reason,
        action.reviewer,
        action.timestamp,
      );
      return [{ ...action, changes }];
    });
    reviews = next.reviews;
    audit = next.audit;
    savedExports = { json: false, csv: false };
    const changes = next.actions[0].changes;
    render();
    el("message").textContent =
      changes.length === 2 ? "両側の判断を記録しました。" : "判断を記録しました。";
    el("message").className = "notice";
    el("review-form").hidden = true;
    renderGuide();
    el("save-json").focus();
  } catch (error) {
    showError(error);
  }
});
el("filter").addEventListener("change", () => {
  if (result) render();
});
el("bulk-save").addEventListener("click", () => {
  try {
    const next = core.stageReviews(result, sources, inputHashes, reviews, audit, (copy) =>
      core.acceptUnreviewed(
        result,
        copy,
        el("bulk-reason").value,
        el("reviewer").value,
        new Date().toISOString(),
        el("bulk-confirm").checked,
      ),
    );
    reviews = next.reviews;
    audit = next.audit;
    savedExports = { json: false, csv: false };
    const actions = next.actions;
    render();
    el("bulk-confirm").checked = false;
    const remaining = core.summary(result, reviews).pending_rows;
    el("message").textContent =
      `${actions.length}組の未記入候補を、人による確認済みとして記録しました。${remaining ? `未記入・未解決は${remaining}行です。` : "全行の判断記録が揃いました。"}`;
    el("message").className = "notice";
  } catch (error) {
    showError(error);
  }
});
el("save-csv").addEventListener("click", () => {
  if (result)
    download(
      `confirmation-${result.options.period}.csv`,
      core.confirmationCSV(result, reviews),
      "text/csv;charset=utf-8",
      "csv",
    );
});
el("save-json").addEventListener("click", () => {
  if (!result) return;
  try {
    const text = core.checkpointJSON(result, sources, inputHashes, reviews, audit);
    download(`reconcile-${result.options.period}.json`, text, "application/json", "json");
  } catch (error) {
    showError(error);
  }
});
el("resume").addEventListener("change", async (event) => {
  try {
    const file = event.target.files[0];
    if (!file) return;
    if (result || processing)
      throw Error("処理を終え、先に保存し、入力を変更するボタンを押してください。");
    if (file.size > 4000000) throw Error("再開ファイルは4MB以内にしてください。");
    const saved = JSON.parse(await file.text());
    if (
      saved.schema_version !== "1.0" ||
      saved.version !== core.VERSION ||
      !Array.isArray(saved.audit) ||
      typeof saved.options?.period !== "string" ||
      typeof saved.options?.corporateAliases !== "boolean"
    )
      throw Error("この確認版の保存形式ではありません。");
    for (const side of ["ledger", "invoices"]) {
      if (
        typeof saved.sources?.[side]?.text !== "string" ||
        typeof saved.sources?.[side]?.name !== "string" ||
        saved.sources[side].text.length > 1000000 ||
        (await hash(saved.sources[side].text)) !== saved.input_hashes?.[side]
      )
        throw Error("保存した入力とハッシュが一致しません。");
    }
    const calculation = core.reconcile(
      core.readInput(saved.sources.ledger.text, "ledger", saved.sources.ledger.name),
      core.readInput(saved.sources.invoices.text, "invoices", saved.sources.invoices.name),
      saved.options,
    );
    const replay = core.replayAudit(calculation, saved.audit);
    if (
      JSON.stringify(replay) !== JSON.stringify(saved.reviews) ||
      JSON.stringify(calculation.rows) !== JSON.stringify(saved.rows)
    )
      throw Error("判断記録または候補の再計算結果が一致しません。");
    core.checkpointJSON(calculation, saved.sources, saved.input_hashes, replay, saved.audit);
    result = calculation;
    reviews = replay;
    audit = saved.audit;
    savedExports = { json: false, csv: false };
    sources = saved.sources;
    inputHashes = saved.input_hashes;
    for (const side of ["ledger", "invoices"]) {
      el(side).value = sources[side].text;
      el(`${side}-name`).value = sources[side].name;
    }
    el("period").value = result.options.period;
    el("aliases").checked = result.options.corporateAliases;
    lock(true);
    el("results").hidden = false;
    el("review-form").hidden = true;
    render();
    el("results").scrollIntoView({ behavior: "smooth", block: "start" });
    el("message").textContent =
      "入力ハッシュと再計算結果を照合し、記録を再開しました。確認者や日時の真正性は保証しません。";
    el("message").className = "notice";
  } catch (error) {
    showError(error);
  } finally {
    event.target.value = "";
  }
});
el("reset").addEventListener("click", () => {
  el("reset-panel").hidden = false;
});
el("reset-cancel").addEventListener("click", () => {
  el("reset-panel").hidden = true;
});
el("reset-confirm").addEventListener("click", () => {
  result = null;
  reviews = {};
  audit = [];
  sources = null;
  inputHashes = null;
  chosen = null;
  lock(false);
  el("results").hidden = true;
  el("review-form").hidden = true;
  el("rows").replaceChildren();
  el("reset-panel").hidden = true;
  el("message").textContent =
    "入力を変更できます。前の判断を引き継ぐには保存したJSONを開いてください。";
});
