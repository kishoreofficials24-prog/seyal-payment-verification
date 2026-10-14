/* Receipt-to-bank-statement matching */

const normalize = (value) =>
  String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");

function amountNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  let cleaned = String(value)
    .replace(/[₹₨■□]/g, "")
    .replace(/\bINR\b/gi, "")
    .replace(/\b(?:Rs\.?|Rupees?)\b/gi, "")
    .replace(/,/g, "")
    .replace(/\s/g, "")
    .trim();

  if (!cleaned || cleaned === "-" || cleaned === "—") return null;
  const negative = /^\(.*\)$/.test(cleaned);
  cleaned = cleaned.replace(/[()]/g, "").replace(/[^\d.+-]/g, "");
  const number = Number(cleaned);
  if (!Number.isFinite(number)) return null;
  return Math.round(Math.abs(negative ? -Math.abs(number) : number) * 100);
}

function makeDate(year, month, day) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100 ||
      month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 &&
    date.getDate() === day ? date : null;
}

function monthNumber(value) {
  const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const index = months.indexOf(String(value).toUpperCase().slice(0, 3));
  return index < 0 ? null : index;
}

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }
  const text = String(value).trim();
  let match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (match) return makeDate(Number(match[1]), Number(match[2]), Number(match[3]));

  match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (match) {
    let year = Number(match[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    return makeDate(year, Number(match[2]), Number(match[1]));
  }

  match = text.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/);
  if (match) {
    const month = monthNumber(match[2]);
    if (month !== null) return makeDate(Number(match[3]), month + 1, Number(match[1]));
  }

  match = text.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (match) {
    const month = monthNumber(match[1]);
    if (month !== null) return makeDate(Number(match[3]), month + 1, Number(match[2]));
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null :
    new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

function withinDays(first, second, days = 2) {
  return Boolean(first && second &&
    Math.abs(first.getTime() - second.getTime()) <= days * 86400000);
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null &&
    String(value).trim() !== "");
}

function receiptFields(receipt) {
  const result = receipt?.result || {};
  const ocr = result.ocr || receipt?.ocr || {};
  const references = [
    ...(Array.isArray(ocr.references) ? ocr.references : []),
    ...(Array.isArray(result.references) ? result.references : []),
    ocr.reference, ocr.transactionReference, result.reference,
    result.transactionReference, receipt?.reference,
  ].filter(Boolean).map(normalize).filter(Boolean);

  return {
    amount: amountNumber(firstPresent(ocr.amount, result.amount, receipt?.amount)),
    references: [...new Set(references)],
    date: parseDate(firstPresent(ocr.date, result.date, receipt?.date)),
  };
}

function transactionFields(row) {
  row = row || {};
  // statementImport.js returns { txnDate, credit, debit, amount, reference, chequeNo }.
  const creditRaw = firstPresent(row.creditAmount, row.credit_amount, row.credit,
    row.deposit, row.depositAmount);
  const debitRaw = firstPresent(row.debitAmount, row.debit_amount, row.debit,
    row.withdrawal, row.withdrawalAmount);
  const credit = creditRaw !== undefined ? amountNumber(creditRaw) : null;
  const debit = debitRaw !== undefined ? amountNumber(debitRaw) : null;
  const directionText = normalize(firstPresent(row.direction, row.type, row.drCr,
    row.transactionType, row.txnType, ""));
  let direction = "UNKNOWN";
  if (credit !== null && credit > 0) direction = "CREDIT";
  else if (debit !== null && debit > 0) direction = "DEBIT";
  else if (["CREDIT","CR","DEPOSIT","IN","INCOMING"].includes(directionText)) direction = "CREDIT";
  else if (["DEBIT","DR","WITHDRAWAL","OUT","OUTGOING"].includes(directionText)) direction = "DEBIT";

  let amount = direction === "CREDIT" && credit !== null && credit > 0 ? credit : null;
  if (amount === null && direction === "CREDIT") {
    amount = amountNumber(firstPresent(row.amount, row.transactionAmount, row.transaction_amount));
  }

  const reference = normalize(firstPresent(row.reference, row.utr, row.transactionId,
    row.transaction_id, row.refNo, row.ref_no, row.chequeNo, row.cheque_no,
    row.transactionReference, row.transaction_reference, ""));
  return {
    amount,
    reference,
    date: parseDate(firstPresent(row.txnDate, row.date, row.transactionDate,
      row.txn_date, row.transaction_date, row.valueDate, row.value_date, "")),
    direction,
    original: row,
  };
}

export function matchReceiptToStatement(receipt, transactions) {
  const payment = receiptFields(receipt);
  const rows = Array.isArray(transactions) ? transactions.map(transactionFields) : [];

  if (payment.amount === null || payment.amount <= 0) {
    return {
      status: "REVIEW",
      reason: "Receipt amount could not be read reliably.",
      message: "Receipt amount could not be read reliably. Please review the receipt.",
      transaction: null, candidates: [], matched: false,
    };
  }

  const credits = rows.filter((row) =>
    row.direction === "CREDIT" && row.amount === payment.amount
  );

  // Compare every OCR reference, not only the first one (e.g. UPI ID and Google transaction ID).
  const exact = payment.references.length
    ? credits.filter((row) => row.reference && payment.references.includes(row.reference))
    : [];

  if (exact.length === 1) {
    const transaction = exact[0];
    if (payment.date && transaction.date && !withinDays(payment.date, transaction.date, 2)) {
      return {
        status: "REVIEW",
        reason: "Reference and amount match, but transaction dates differ. Please review.",
        message: "Reference and amount match, but transaction dates differ. Please review.",
        transaction: transaction.original, candidates: [transaction.original], matched: false,
      };
    }
    return {
      status: "MATCH",
      reason: "Exact reference and amount match an incoming bank credit.",
      message: "Exact transaction reference and amount match an incoming bank credit.",
      transaction: transaction.original, candidates: [transaction.original], matched: true,
    };
  }

  if (exact.length > 1) {
    return {
      status: "REVIEW",
      reason: "Multiple incoming credits have the same reference and amount.",
      message: "Multiple incoming credits have the same reference and amount. Please review.",
      transaction: null, candidates: exact.map((row) => row.original), matched: false,
    };
  }

  // If receipt date was not extracted, still surface same-amount credits for review.
  let possible = credits;
  if (payment.date) {
    possible = possible.filter((row) => row.date && withinDays(payment.date, row.date, 2));
  }

  if (possible.length === 1) {
    return {
      status: "REVIEW",
      reason: "Incoming credit amount matches, but exact receipt reference did not match.",
      message: "Incoming credit amount matches, but the transaction reference is different or missing. Please review.",
      transaction: possible[0].original, candidates: [possible[0].original], matched: false,
    };
  }
  if (possible.length > 1) {
    return {
      status: "REVIEW",
      reason: "Multiple incoming credits match the amount/date. Manual review is required.",
      message: "Multiple incoming credits match the amount/date. Manual review is required.",
      transaction: null, candidates: possible.map((row) => row.original), matched: false,
    };
  }

  const sameAmount = rows.filter((row) => {
    const original = row.original || {};
    const values = [original.credit, original.creditAmount, original.credit_amount,
      original.deposit, original.amount, original.debit, original.debitAmount];
    return values.some((value) => amountNumber(value) === payment.amount);
  });

  if (sameAmount.length) {
    return {
      status: "REVIEW",
      reason: "A transaction with this amount exists, but a confirmed incoming-credit match was not found.",
      message: "A transaction with this amount exists, but a confirmed incoming-credit match was not found. Please review.",
      transaction: null, candidates: sameAmount.map((row) => row.original), matched: false,
    };
  }

  return {
    status: "PENDING",
    reason: "No matching incoming credit was found in the imported bank statement.",
    message: "No matching incoming credit was found in the imported bank statement.",
    transaction: null, candidates: [], matched: false,
  };
}
