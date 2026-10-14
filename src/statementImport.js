import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf";

pdfjsLib.GlobalWorkerOptions.workerSrc = `${process.env.PUBLIC_URL}/pdf.worker.min.js`;

const clean = (value) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toLocaleDateString("en-GB");
  }
  return String(value ?? "").replace(/\uFEFF/g, "").replace(/\s+/g, " ").trim();
};
const key = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]/g, "");

function money(value) {
  let text = clean(value).replace(/[■■,\s]/g, "").replace(/\bINR\b/gi, "").replace(/\b(?:CR|DR)\b/gi, "");
  if (!text || text === "-" || text === "—") return 0;
  const negative = text.startsWith("-") || (text.startsWith("(") && text.endsWith(")"));
  const n = Number(text.replace(/[()]/g, "").replace(/[^\d.+-]/g, ""));
  return Number.isFinite(n) ? (negative ? -Math.abs(n) : Math.abs(n)) : 0;
}

const aliases = {
  date: ["txndate", "transactiondate", "transactiondt", "date", "postingdate"],
  valueDate: ["valuedate", "valuedt"],
  debit: ["debit", "debitamount", "withdrawal", "withdrawals", "withdrawalamount", "withdrawalamt", "dr", "dramount"],
  credit: ["credit", "creditamount", "deposit", "deposits", "depositamount", "depositamt", "cr", "cramount"],
  description: ["description", "narration", "remarks", "particulars", "transactiondetails", "transactiondescription", "details"],
  reference: ["chequeno", "chequenumber", "referenceno", "referencenumber", "transactionreference", "transactionid", "utr", "utrno", "rrn", "refno", "bankrefno", "bankreference", 
"paymentreference", "upiutr"],
  branch: ["branchcode"],
  balance: ["balance", "closingbalance", "runningbalance", "availablebalance"],
};
function findColumn(headers, names) {
  const normalized = headers.map(key);
  let index = normalized.findIndex((v) => names.includes(v));
  if (index >= 0) return index;
  return normalized.findIndex((v) => names.some((name) => v.length > name.length && v.includes(name)));
}
function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 80); i++) {
    const h = rows[i] || [];
    if (findColumn(h, aliases.date) >= 0 &&
        findColumn(h, aliases.credit) >= 0 &&
        findColumn(h, aliases.balance) >= 0) return { index: i, headers: h };
  }
  for (let i = 0; i < Math.min(rows.length, 80); i++) {
    const h = rows[i] || [];
    if (findColumn(h, aliases.date) >= 0 &&
        (findColumn(h, aliases.credit) >= 0 || findColumn(h, aliases.debit) >= 0)) return { index: i, headers: h };
  }
  return null;
}

function parseRows(inputRows, bank, sourceName) {
  const rows = inputRows.map((r) => Array.isArray(r) ? r.map(clean) : []).filter((r) => r.some(Boolean));
  const header = findHeaderRow(rows);
  if (!header) throw new Error("Could not identify bank statement columns. Try exporting the statement as CSV/XLSX.");
  const { index: headerIndex, headers } = header;
  const col = Object.fromEntries(Object.entries(aliases).map(([name, names]) => [name, findColumn(headers, names)]));
  const amountCol = findColumn(headers, ["amount", "transactionamount", "txnamount"]);
  const importedAt = new Date().toISOString();

  const result = [];
  rows.slice(headerIndex + 1).forEach((row, rowIndex) => {
    const txnDate = clean(row[col.date]);
    if (!txnDate || ["date", "txndate", "transactiondate"].includes(key(txnDate))) return;
    const credit = col.credit >= 0 ? Math.abs(money(row[col.credit])) : 0;
    const debit = col.debit >= 0 ? Math.abs(money(row[col.debit])) : 0;
    const amount = amountCol >= 0 ? Math.abs(money(row[amountCol])) : 0;
    const description = col.description >= 0 ? clean(row[col.description]) : "";
    const reference = col.reference >= 0 ? clean(row[col.reference]) : "";
    const balance = col.balance >= 0 ? Math.abs(money(row[col.balance])) : 0;
    if (!credit && !debit && !amount && !description) return;
    const finalCredit = credit || (
      col.credit < 0 && amount > 0 && /\b(credit|credited|deposit|received|upi\/cr|neft cr|imps cr)\b/i.test(`${description} ${row.join(" ")}`)



        ? amount : 0
    );
    result.push({
      id: `${bank}-${sourceName}-${rowIndex}`.replace(/[^a-zA-Z0-9_-]/g, "_"),
      bank, sourceName, sourceOrder: rowIndex, txnDate,
      valueDate: col.valueDate >= 0 ? clean(row[col.valueDate]) : "",
      chequeNo: reference, reference, description,
      branchCode: col.branch >= 0 ? clean(row[col.branch]) : "",
      debit, credit: finalCredit, balance,
      amount: finalCredit || debit || amount,
      direction: finalCredit > 0 ? "CREDIT" : debit > 0 ? "DEBIT" : "UNKNOWN",
      importedAt,
    });
  });
  if (!result.length) throw new Error("No transaction rows could be extracted from the statement.");
  return result;
}

function parseDelimited(text, delimiter) {
  const rows = []; let row = []; let cell = ""; let quoted = false;
  const input = String(text ?? "").replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '"') {
      if (quoted && input[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (c === delimiter && !quoted) { row.push(cell.trim()); cell = ""; }
    else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && input[i + 1] === "\n") i++;
      row.push(cell.trim()); if (row.some(Boolean)) rows.push(row);
      row = []; cell = "";
    } else cell += c;
  }
  row.push(cell.trim()); if (row.some(Boolean)) rows.push(row);
  return rows;
}
function parseCsv(text) {
  const line = String(text ?? "").split(/\r?\n/).find((x) => x.trim());
  if (!line) return [];
  const delimiters = [",", ";", "\t", "|"];
  const delimiter = delimiters.map((d) => ({ d, n: line.split(d).length })).sort((a,b) => b.n-a.n)[0].d;
  return parseDelimited(text, delimiter);
}
function isTxnDate(text) {
  return /^\d{1,2}[-/]\d{1,2}[-/]\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?/.test(clean(text)) ||
    /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(clean(text));
}

function buildPdfRows(items, pageNumber) {
  // Keep PDF text items positioned, and use the table header's x-coordinates as column anchors.
  const linesMap = new Map();
  for (const item of items) {
    if (!item.str || !item.str.trim()) continue;
    const y = Math.round(Number(item.transform?.[5] || 0) / 2) * 2;
    if (!linesMap.has(y)) linesMap.set(y, []);
    linesMap.get(y).push({ x: Number(item.transform?.[4] || 0), width: Number(item.width || 0), text: clean(item.str) });
  }
  const lines = [...linesMap.entries()].sort((a,b) => b[0]-a[0]).map(([y, parts]) => ({y, parts: parts.sort((a,b)=>a.x-b.x)}));
  const headerWords = [
    ["date", ["txndate", "transactiondate"]],
    ["valueDate", ["valuedate"]],
    ["reference", ["chequeno"]],
    ["description", ["description"]],
    ["branch", ["branchcode", "branch"]],
    ["debit", ["debit"]],
    ["credit", ["credit"]],
    ["balance", ["balance"]],
  ];
  let headerLine = -1;
  let anchors = [];
  for (let i = 0; i < lines.length; i++) {
    const found = [];
    for (const [name, terms] of headerWords) {
      let part = lines[i].parts.find(p => terms.includes(key(p.text)));



      if (!part) continue;
      found.push({name, x:part.x});
    }
    if (found.some(a=>a.name==="date") && found.some(a=>a.name==="credit") && found.some(a=>a.name==="balance")) {
      headerLine = i; anchors = found.sort((a,b)=>a.x-b.x); break;
    }
  }
  if (headerLine < 0 || anchors.length < 4) {
    // Preserve a plain-text fallback but do not fabricate column values.
    return lines.map(({parts}) => parts.map(p=>p.text));
  }
  const boundaries = anchors.map((a,i)=>({
    ...a,
    left: i===0 ? -Infinity : (anchors[i-1].x+a.x)/2,
    right: i===anchors.length-1 ? Infinity : (a.x+anchors[i+1].x)/2,
  }));
  const transactionRows = [];
  let current = null;
  const dateBoundary = boundaries.find(b=>b.name==="date");
  const columnFor = (item) => {
    const center = item.x + item.width/2;
    return boundaries.find(b=>center>=b.left && center<b.right)?.name || "";
  };
  for (let i = headerLine + 1; i < lines.length; i++) {
    const line = lines[i];
    const dateItem = line.parts.find(p => columnFor(p)==="date" && isTxnDate(p.text));
    if (dateItem) {
      if (current) transactionRows.push(current);
      current = { date: "", valueDate: "", reference: "", description: "", branch: "", debit: "", credit: "", balance: "", pageNumber };
    }
    if (!current) continue;
    for (const p of line.parts) {
      const column = columnFor(p);
      if (!column) continue;
      const text = p.text;
      if (column === "date" && isTxnDate(text)) current.date = `${current.date} ${text}`.trim();
      else if (column === "valueDate" && text) current.valueDate = `${current.valueDate} ${text}`.trim();
      else if (column === "reference" && text) current.reference = `${current.reference} ${text}`.trim();
      else if (column === "description" && text) current.description = `${current.description} ${text}`.trim();
      else if (column === "branch" && text) current.branch = `${current.branch} ${text}`.trim();
      else if (["debit","credit","balance"].includes(column) && text) {
        // Numeric values only belong to their anchored numeric column. Balance is never used as credit.
        if (/[0-9]/.test(text)) current[column] = `${current[column]} ${text}`.trim();
      }
    }
  }
  if (current) transactionRows.push(current);

  return [
    ["Txn Date","Value Date","Cheque No.","Description","Branch Code","Debit","Credit","Balance"],
    ...transactionRows.map(r=>[r.date,r.valueDate,r.reference,r.description,r.branch,r.debit,r.credit,r.balance]),
  ];
}

async function parsePdf(file, bank) {
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer(), useWorkerFetch: false, isEvalSupported: false }).promise;
  const allRows = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const rows = buildPdfRows(content.items, pageNumber);
    // Only the first page's header should be parsed as headings; each later page has its own repeated header.
    if (pageNumber > 1 && rows.length && key(rows[0]?.[0]) === "txndate") rows.shift();
    allRows.push(...rows);
  }
  return parseRows(allRows, bank, file.name);
}

export async function importStatementFile(file, bank) {
  if (!file) throw new Error("Please choose a bank statement file.");
  const extension = file.name.split(".").pop().toLowerCase();
  if (extension === "csv" || file.type === "text/csv") {
    return parseRows(parseCsv(await file.text()), bank, file.name);
  }



  if (extension === "xlsx" || extension === "xls") {
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(await file.arrayBuffer(), { type:"array", cellDates:true, raw:false });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error("The Excel workbook has no worksheet.");
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header:1, defval:"", raw:false });
    return parseRows(rows, bank, file.name);
  }
  if (extension === "pdf" || file.type === "application/pdf") return parsePdf(file, bank);
  throw new Error("Choose a PDF, CSV, XLS or XLSX bank statement.");
}