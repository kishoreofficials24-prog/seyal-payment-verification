 import { createWorker } from "tesseract.js";

let workerPromise;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker("eng").catch((error) => {
      workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

const normalizeText = (text) =>
  String(text || "").replace(/\r/g, "\n").replace(/[ \t]+/g, " ").trim();

function normalizeAmount(value) {
  const cleaned = String(value ?? "")
    .replace(/[₹₨,\s]/g, "")
    .replace(/\b(?:INR|Rs\.?)/gi, "")
    .replace(/[^\d.]/g, "");

  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(cleaned)) return "";
  const amount = Number(cleaned);
  return Number.isFinite(amount) && amount > 0
    ? (Number.isInteger(amount) ? String(amount) : amount.toFixed(2))
    : "";
}

/* Prefer numbers printed next to a currency symbol. Never treat long UPI IDs as amounts. */
function extractAmount(text) {
  const normalized = normalizeText(text);
  const lines = normalized.split("\n").map((line) => line.trim()).filter(Boolean);
  const currencyCandidates = [];
  const labelledCandidates = [];
  const standaloneCandidates = [];

  const add = (list, value, line) => {
    const amount = normalizeAmount(value);
    if (!amount) return;
    // Ignore long identifier-like strings, dates, and times.
    if (/^\d{8,}$/.test(String(value).replace(/[,\s]/g, ""))) return;
    if (/\b(?:UPI|UTR|RRN|transaction\s*id|google\s*(?:pay|transaction)|account|phone|mobile|reference)\b/i.test(line)) return;
    list.push(amount);
  };

  for (const line of lines) {
    for (const match of line.matchAll(/(?:₹|₨|\bINR\b|\bRs\.?\s*)\s*([0-9][0-9,]*(?:\.\d{1,2})?)/gi)) {
      add(currencyCandidates, match[1], line);
    }

    for (const match of line.matchAll(/(?:amount paid|paid amount|payment amount|transaction amount|total paid|amount|paid)\s*[:\-]?\s*(?:₹|₨|INR|Rs\.?\s*)?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/gi)) {
      add(labelledCandidates, match[1], line);
    }

    const standalone = line.match(/^(?:₹|₨|INR|Rs\.?\s*)\s*([0-9][0-9,]*(?:\.\d{1,2})?)$/i)
      || line.match(/^(?:₹|₨|INR|Rs\.?\s*)?([0-9][0-9,]*(?:\.\d{1,2})?)$/i);

    if (standalone && !/\d{1,2}:\d{2}|\b20\d{2}\b/.test(line)) {
      add(standaloneCandidates, standalone[1], line);
    }
  }

  // A clear currency-marked value outranks every other number on a receipt.
  if (currencyCandidates.length) {
    const counts = new Map();
    currencyCandidates.forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }

  if (labelledCandidates.length) {
    const counts = new Map();
    labelledCandidates.forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }

  // Only use standalone numbers when OCR did not find any currency-marked amount.
  if (standaloneCandidates.length === 1) return standaloneCandidates[0];
  const counts = new Map();
  standaloneCandidates.forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

function extractReferences(text) {
  const value = normalizeText(text);
  const results = [];
  const patterns = [
    /(?:UPI\s*(?:transaction\s*)?ID|Google\s*(?:Pay\s*)?(?:transaction\s*)?ID|transaction\s*(?:reference|ref(?:erence)?\s*no\.?|ID|number)|UTR(?:\s*no\.?)?|RRN|bank\s*reference|reference\s*number|txn\s*ID)\s*[:#\-]?\s*([A-Z0-9][A-Z0-9_-]{5,})/gi,
    /\b(?:UTR|RRN|UPI|TXN)[\s:#-]*([A-Z0-9][A-Z0-9_-]{7,})\b/gi,
  ];

  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const candidate = match[1].replace(/[.,;:]$/, "");
      if (candidate && !/^0+$/.test(candidate) && !results.includes(candidate)) results.push(candidate);
    }
  }

  // Google Pay often shows the UPI ID first and the Google transaction ID later.
  // Keep all detected IDs so the statement matcher can compare either one.
  return results;
}

function extractReference(text) {
  return extractReferences(text)[0] || "";
}

function extractDate(text) {
  const patterns = [
    /\b(\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?,?\s+\d{4})\b/i,
    /\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/,
    /\b(\d{4}[/-]\d{1,2}[/-]\d{1,2})\b/,
  ];
  for (const pattern of patterns) {
    const match = String(text || "").match(pattern);
    if (match) return match[1];
  }
  // Some Google Pay screenshots display a date followed by a time, e.g. "25 Sep., 2026, 11:56 AM".
  const localDate = String(text || "").match(/\b(\d{1,2}\s+[A-Za-z]{3,9}\.?,?\s+\d{4})\b/i);
  return localDate ? localDate[1].replace(/\./g, "") : "";
}

function extractTime(text) {
  const value = String(text || "");
  const match =
    value.match(/\b(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM))\b/i) ||
    value.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
  return match ? match[1].trim() : "";
}

function detectPaymentScreen(text) {
  const value = String(text || "").toLowerCase();
  if (/requested money from you|request received|ignore this request|payment request/.test(value)) {
    return { type: "PAYMENT_REQUEST", message: "This appears to be a payment request, not proof of a completed payment." };
  }
  if (/\bcompleted\b|\bsuccessful\b|payment successful|paid successfully|transaction successful|முடிந்தது/.test(value)) {
    return { type: "PAYMENT_RECEIPT", message: "A completion message was detected. Actual payment still needs bank verification." };
  }
  if (/thanks!|thank you/.test(value)) {
    return { type: "POSSIBLE_PAYMENT_RECEIPT", message: "A thank-you message was detected, but the screenshot alone does not prove payment." };
  }
  return { type: "UNKNOWN", message: "Payment status could not be reliably identified from the screenshot." };
}

export function extractPaymentFields(text) {
  const rawText = normalizeText(text);
  const screen = detectPaymentScreen(rawText);
  const references = extractReferences(rawText);
  return {
    amount: extractAmount(rawText),
    reference: references[0] || "",
    references,
    date: extractDate(rawText),
    time: extractTime(rawText),
    paymentType: screen.type,
    message: screen.message,
    rawText,
  };
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not load receipt image."));
    };
    image.src = url;
  });
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("Could not process receipt image.")),
      "image/png"
    );
  });
}

async function imageVariants(file) {
  const image = await loadImage(file);
  const scale = Math.min(3, 3000 / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not process receipt image.");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
  const original = await canvasToBlob(canvas);

  const gray = document.createElement("canvas");
  gray.width = width;
  gray.height = height;
  const gctx = gray.getContext("2d");
  if (!gctx) throw new Error("Could not process receipt image.");
  gctx.drawImage(canvas, 0, 0);
  const data = gctx.getImageData(0, 0, width, height);
  for (let i = 0; i < data.data.length; i += 4) {
    const v = Math.max(0, Math.min(255, ((data.data[i] * 0.299 + data.data[i + 1] * 0.587 + data.data[i + 2] * 0.114) - 128) * 1.25 + 128));
    data.data[i] = data.data[i + 1] = data.data[i + 2] = v;
  }
  gctx.putImageData(data, 0, 0);
  const grayBlob = await canvasToBlob(gray);

  return [
    { name: "original-upscaled", blob: original },
    { name: "grayscale-contrast", blob: grayBlob },
  ];
}

async function recognize(worker, blob, name, psm) {
  await worker.setParameters({
    tessedit_pageseg_mode: String(psm),
    preserve_interword_spaces: "1",
  });
  const result = await worker.recognize(blob);
  return {
    name,
    text: result.data.text || "",
    confidence: Number.isFinite(result.data.confidence) ? result.data.confidence : 0,
  };
}

/* Crop the large amount near the top of tall mobile payment screenshots. */
async function recognizeAmountCrop(file, worker) {
  const image = await loadImage(file);
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height) return "";

  // Google Pay receipts usually place the large paid amount in the upper quarter.
  const cropX = Math.round(width * 0.12);
  const cropY = Math.round(height * 0.14);
  const cropW = Math.round(width * 0.76);
  const cropH = Math.round(height * 0.18);

  const canvas = document.createElement("canvas");
  const scale = Math.min(4, 2400 / Math.max(cropW, cropH));
  canvas.width = Math.max(1, Math.round(cropW * scale));
  canvas.height = Math.max(1, Math.round(cropH * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height);
  const blob = await canvasToBlob(canvas);

  let best = "";
  for (const psm of [7, 6, 11]) {
    try {
      const pass = await recognize(worker, blob, `amount-crop-${psm}`, psm);
      const amount = extractAmount(pass.text);
      if (amount && (!best || amount.length < best.length)) best = amount;
    } catch (error) {
      console.warn("Amount crop OCR failed", psm, error);
    }
  }
  return best;
}

export async function readReceiptImage(file) {
  if (!file || !file.type?.startsWith("image/")) {
    throw new Error("Please provide a valid receipt image. PDF OCR is not supported by this function.");
  }

  const worker = await getWorker();
  const passes = [];

  try {
    const first = await worker.recognize(file);
    passes.push({
      name: "original",
      text: first.data.text || "",
      confidence: Number.isFinite(first.data.confidence) ? first.data.confidence : 0,
    });
  } catch (error) {
    console.warn("Original OCR pass failed", error);
  }

  try {
    for (const variant of await imageVariants(file)) {
      for (const psm of [6, 11]) {
        try {
          passes.push(await recognize(worker, variant.blob, `${variant.name}-psm${psm}`, psm));
        } catch (error) {
          console.warn("OCR pass failed", variant.name, psm, error);
        }
      }
    }
  } catch (error) {
    console.warn("Receipt image preprocessing failed", error);
  }

  let cropAmount = "";
  try {
    cropAmount = await recognizeAmountCrop(file, worker);
  } catch (error) {
    console.warn("Amount crop OCR failed", error);
  }

  try {
    await worker.setParameters({
      tessedit_pageseg_mode: "3",
      preserve_interword_spaces: "0",
    });
  } catch (error) {
    console.warn("Could not reset OCR parameters", error);
  }

  const allText = passes.map((pass) => pass.text).join("\n\n");
  const currencyAmounts = [];
  for (const pass of passes) {
    const text = pass.text;
    const matches = [...text.matchAll(/(?:₹|₨|\bINR\b|\bRs\.?\s*)\s*([0-9][0-9,]*(?:\.\d{1,2})?)/gi)];
    matches.forEach((match) => {
      const amount = normalizeAmount(match[1]);
      if (amount && !/^\d{8,}$/.test(match[1].replace(/[,\s]/g, ""))) currencyAmounts.push(amount);
    });
  }

  const counts = new Map();
  currencyAmounts.forEach((amount) => counts.set(amount, (counts.get(amount) || 0) + 1));
  let amount = cropAmount || [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";

  // Fall back to the text extractor only if no currency-marked amount was found.
  if (!amount) amount = extractAmount(allText);

  const references = extractReferences(allText);
  const screen = detectPaymentScreen(allText);
  const confidenceList = passes.map((pass) => pass.confidence).filter(Number.isFinite);

  return {
    amount,
    amountNeedsReview: !amount || (!cropAmount && (counts.get(amount) || 0) < 2),
    amountCandidates: [...counts.entries()].map(([candidate, votes]) => ({ amount: candidate, votes })),
    reference: references[0] || "",
    references,
    date: extractDate(allText),
    time: extractTime(allText),
    paymentType: screen.type,
    message: screen.message,
    rawText: allText,
    confidence: confidenceList.length
      ? Math.round(confidenceList.reduce((sum, value) => sum + value, 0) / confidenceList.length)
      : null,
  };
}
