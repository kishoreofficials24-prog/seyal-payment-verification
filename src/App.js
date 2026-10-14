import React, { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import "./statement-import.css";
import "./match-edit.css"; // green MATCH theme + amount edit styles
import { importStatementFile } from "./statementImport";
import { matchReceiptToStatement } from "./statementMatching";
import { getReceipts, saveReceipts, deleteReceipt } from "./receiptStorage";
import { readReceiptImage } from "./receiptOcr";

/* ---------------- HELPERS ---------------- */

function formatReceiptAmount(value) {
  const cleaned = String(value ?? "")
    .replace(/[₹\s,]/g, "")
    .replace(/[^0-9.\-]/g, "");
  if (!cleaned || !Number.isFinite(Number(cleaned))) return "Not detected";
  return `Rs. ${Number(cleaned).toLocaleString("en-IN", {
    maximumFractionDigits: 2,
  })}`;
}

// Converts "Rs. 1,500.00", "₹1500", "1500" etc. into a number
function parseMoney(value) {
  const text = String(value ?? "")
    .replace(/[₹,\s]/g, "")
    .replace(/^Rs\.?/i, "");
  const number = Number(text.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

// Incoming (credit) amount of a bank transaction, or 0
function incomingAmountOf(txn) {
  const credit = parseMoney(txn.credit ?? txn.creditAmount);
  const direction = String(txn.direction || "").toUpperCase();
  const generic = parseMoney(txn.amount);
  return credit > 0 ? credit : direction === "CREDIT" ? generic : 0;
}

function hasMatchingCredit(amount, transactions) {
  const target = parseMoney(amount);
  if (target <= 0) return false;
  return (transactions || []).some((txn) => {
    const incoming = incomingAmountOf(txn);
    return incoming > 0 && Math.abs(incoming - target) < 0.01;
  });
}

function parseLocalDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }
  const text = String(value).trim();
  let match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (match) {
    let year = Number(match[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    return new Date(year, Number(match[2]) - 1, Number(match[1]));
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime())
    ? null
    : new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

// Date range covered by the imported statement
function getStatementRange(transactions) {
  const dates = (transactions || [])
    .map((row) =>
      parseLocalDate(row.txnDate || row.date || row.transactionDate || row.valueDate || "")
    )
    .filter(Boolean)
    .sort((a, b) => a.getTime() - b.getTime());
  return dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null;
}

const MATCH_REASON =
  "An incoming bank credit with the same amount was found. Matching entries are listed below.";

const MISMATCH_REASON =
  "No matching incoming credit was found for this receipt in the imported statement period. Please review; this alone does not prove a failed or fraudulent payment.";

// One verdict logic used everywhere (upload, statement import, amount edit)
function buildVerdict(receipt, transactions) {
  if (hasMatchingCredit(receipt.result?.amount, transactions)) {
    return { status: "MATCH", reason: MATCH_REASON, message: MATCH_REASON };
  }

  const verdict = matchReceiptToStatement(receipt, transactions);

  // No credit found, but the statement covers the receipt date -> MISMATCH
  if (verdict.status === "PENDING") {
    const range = getStatementRange(transactions);
    const receiptDate = parseLocalDate(
      receipt.result?.date || receipt.result?.ocr?.date || receipt.date || ""
    );
    if (range && receiptDate && receiptDate >= range.start && receiptDate <= range.end) {
      return { ...verdict, status: "MISMATCH", reason: MISMATCH_REASON, message: MISMATCH_REASON };
    }
  }
  return verdict;
}

/* ---------------- ICONS ---------------- */

const Icon = ({ name, size = 18 }) => {
  const paths = {
    upload: <><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/></>,
    report: <><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></>,
    shield: <><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/></>,
    file: <><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M13 2v7h7M8 14h8M8 18h6"/></>,
    close: <><path d="m18 6-12 12M6 6l12 12"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    print: <><path d="M6 9V3h12v6"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v7H6z"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m16 16 4 4"/></>,
    arrow: <><path d="M7 17 17 7M7 7h10v10"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    check: <><path d="m5 12 5 5 9-10"/></>,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.file}
    </svg>
  );
};

const sizeLabel = (bytes = 0) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / 1048576).toFixed(2)} MB`;

function FileArtwork({ file }) {
  if (file?.preview) {
    return (
      <img
        className="file-preview-image"
        src={file.preview}
        alt=""
        draggable="false"
      />
    );
  }
  return (
    <div className="file-paper">
      <div className="paper-fold" />
      <div className="paper-lines">
        <i /><i /><i /><i />
      </div>
      <span className="paper-type">
        {file?.type === "application/pdf" ? "PDF" : "FILE"}
      </span>
    </div>
  );
}

/* ---------------- MAIN APP ---------------- */

export default function App() {
  const inputRef = useRef(null);
  const basketRef = useRef(null);
  const dragRef = useRef(null);
  const urlsRef = useRef(new Set());
  const storageReadyRef = useRef(false);
  const saveQueueRef = useRef(Promise.resolve());
  const saveTimerRef = useRef(null);

  const [page, setPage] = useState("upload");
  const [files, setFiles] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [drag, setDrag] = useState(null);
  const [aiming, setAiming] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [detail, setDetail] = useState(null);
  const [search, setSearch] = useState("");
  const [shot, setShot] = useState(null);
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState("");

  // Bank statement import and matching
  const statementInputRef = useRef(null);
  const [bankTransactions, setBankTransactions] = useState([]);
  const [bank, setBank] = useState("Federal Bank");
  const [period, setPeriod] = useState("daily");
  const [periodDate, setPeriodDate] = useState(new Date().toISOString().slice(0, 10));
  const [customStart, setCustomStart] = useState(new Date().toISOString().slice(0, 10));
  const [customEnd, setCustomEnd] = useState(new Date().toISOString().slice(0, 10));
  const [statementBusy, setStatementBusy] = useState(false);
  const [statementMessage, setStatementMessage] = useState("");

  // Editable amount + recheck feedback
  const [editingAmount, setEditingAmount] = useState(false);
  const [amountDraft, setAmountDraft] = useState("");
  const [recheckNote, setRecheckNote] = useState("");

  const activeFile = files.find((file) => file.id === activeId);
  const draggedFile = drag ? files.find((file) => file.id === drag.id) : null;

  // Reset edit mode and note whenever a different receipt is opened / modal closes
  useEffect(() => {
    setEditingAmount(false);
    setRecheckNote("");
  }, [detail?.id]);

  /* ---------------- LOAD SAVED RECEIPTS ---------------- */
  useEffect(() => {
    let cancelled = false;
    async function loadReceipts() {
      try {
        const saved = await getReceipts();
        if (cancelled) return;
        const restored = saved.map((receipt) => {
          const blob = receipt.blob || receipt.originalFile || null;
          let preview = null;
          if (blob && blob.type?.startsWith("image/")) {
            preview = URL.createObjectURL(blob);
            urlsRef.current.add(preview);
          }
          return {
            ...receipt,
            originalFile: blob,
            preview,
            status: receipt.status || "READY",
          };
        });
        setFiles(restored);
        setStorageError("");
        storageReadyRef.current = true;
        setStorageReady(true);
      } catch (error) {
        console.error("Unable to load saved receipts:", error);
        setStorageError(
          "Saved receipts could not be loaded. Refresh the app or check browser storage."
        );
        // Do not enable saving after a failed load (prevents overwriting data).
      }
    }
    loadReceipts();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------------- IMPORT BANK STATEMENT ---------------- */
  // Bank statement rows exist only in this browser session and are cleared on refresh.
  const handleStatementImport = async (event) => {
    const input = event.target;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;

    setStatementBusy(true);
    setStatementMessage("");

    try {
      const parsedRows = await importStatementFile(file, bank);
      const importedRows = Array.isArray(parsedRows) ? parsedRows : [];

      if (!importedRows.length) {
        setStatementMessage(
          "Import failed: no transaction rows were extracted. No receipt status was changed."
        );
        return;
      }

      const merged = importedRows.map((row, index) => ({
        ...row,
        id: row.id || `${bank}-${row.txnDate || row.date || "txn"}-${index}`,
        bank: row.bank || bank,
        sourceOrder: row.sourceOrder ?? index,
      }));
      setBankTransactions(merged);

      const range = getStatementRange(importedRows);
      const savedReceipts = await getReceipts();
      const savedById = new Map(savedReceipts.map((r) => [r.id, r]));

      const updatedFiles = files.map((receipt) => {
        if (!receipt.result) return receipt;

        // buildVerdict already handles MATCH / REVIEW / MISMATCH / PENDING
        const verdict = buildVerdict(receipt, merged);
        const finalStatus = verdict.status;
        const finalReason = verdict.reason || verdict.message || "Verification needs review.";

        const updated = {
          ...receipt,
          status: finalStatus,
          result: {
            ...receipt.result,
            status: finalStatus,
            message: finalReason,
            matching: { ...verdict, status: finalStatus, reason: finalReason },
          },
        };

        const prior = savedById.get(receipt.id);
        savedById.set(
          receipt.id,
          prior
            ? { ...prior, ...updated, blob: prior.blob || receipt.originalFile || null }
            : { ...updated, blob: receipt.originalFile || receipt.blob || null }
        );
        return updated;
      });

      setFiles(updatedFiles);

      const receiptsToSave = Array.from(savedById.values()).map((receipt) => ({
        ...receipt,
        blob: receipt.originalFile || receipt.blob || null,
      }));
      await saveReceipts(receiptsToSave);

      if (detail) {
        const refreshed = updatedFiles.find((r) => r.id === detail.id);
        if (refreshed) setDetail(refreshed);
      }

      const checked = updatedFiles.filter((r) => r.result);
      const count = (s) => checked.filter((r) => r.status === s).length;

      setStatementMessage(
        `Imported ${importedRows.length} transaction(s) from ${bank}. ` +
          `Receipts checked: ${checked.length}. MATCH: ${count("MATCH")}, ` +
          `REVIEW: ${count("REVIEW")}, MISMATCH: ${count("MISMATCH")}, PENDING: ${count("PENDING")}. ` +
          `Statement dates: ${range ? range.start.toLocaleDateString("en-GB") : "unknown"} - ` +
          `${range ? range.end.toLocaleDateString("en-GB") : "unknown"}.`
      );
    } catch (error) {
      console.error("Statement import failed:", error);
      setStatementMessage(
        error?.message || "Could not import this statement. Check the file and try again."
      );
    } finally {
      setStatementBusy(false);
    }
  };

  /* ---------------- SAVE RECEIPTS ---------------- */
  useEffect(() => {
    if (!storageReady || !storageReadyRef.current) return;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);

    // Debounce rapid animation/status updates.
    saveTimerRef.current = window.setTimeout(() => {
      const snapshot = files.map((file) => ({
        ...file,
        blob: file.originalFile || file.blob || null,
      }));
      saveQueueRef.current = saveQueueRef.current
        .then(() => saveReceipts(snapshot))
        .then(() => setStorageError(""))
        .catch((error) => {
          console.error("Receipt save failed:", error);
          setStorageError("Receipt saving failed. Check available browser storage space.");
        });
    }, 250);

    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, [files, storageReady]);

  /* ---------------- CLEAN UP PREVIEWS ---------------- */
  useEffect(() => {
    return () => {
      urlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      urlsRef.current.clear();
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, []);

  /* ---------------- ADD FILES ---------------- */
  const addFiles = useCallback((list) => {
    const allowed = Array.from(list || []).filter((file) =>
      ["image/png", "image/jpeg", "image/webp", "application/pdf"].includes(file.type)
    );
    if (!allowed.length) {
      window.alert("Choose a PNG, JPG, WEBP or PDF file.");
      return;
    }
    const added = allowed.map((file) => {
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
      if (preview) urlsRef.current.add(preview);
      return {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        originalFile: file,
        name: file.name,
        size: file.size,
        type: file.type,
        preview,
        status: "READY",
        result: null,
        addedAt: new Date().toLocaleString(),
      };
    });
    setFiles((previous) => [...added, ...previous]);
    setActiveId(added[0].id);
    setStorageError("");
  }, []);

  /* ---------------- BASKET DRAGGING ---------------- */
  const startDrag = (event, file) => {
    if (event.button !== 0 || file.status !== "READY" || processing || dragRef.current) {
      return;
    }
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const next = {
      id: file.id,
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      originX: rect.left,
      originY: rect.top,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
      moved: false,
    };
    dragRef.current = next;
    setDrag(next);
    setActiveId(file.id);
  };

  /* ---------------- SUBMIT SHOT ---------------- */
  const submitShot = (id, dragData, basketRect) => {
    if (processing) return;
    const file = files.find((item) => item.id === id);
    if (!file || file.status !== "READY") return;

    const width = dragData.width;
    const height = dragData.height;
    const basketX = basketRect.left + basketRect.width / 2 - width / 2;
    const basketY = basketRect.top + 4;
    const landingX = Math.max(12, Math.min(window.innerWidth - width - 12, basketX));
    const landingY = Math.min(window.innerHeight - height - 28, basketRect.bottom + 92);

    setActiveId(id);
    setProcessing(true);
    setFiles((previous) =>
      previous.map((item) => (item.id === id ? { ...item, status: "SHOOTING" } : item))
    );
    setShot({
      id,
      phase: "flight",
      startX: dragData.originX,
      startY: dragData.originY,
      basketX,
      basketY,
      landingX,
      landingY,
      width,
      height,
    });
  };

  /* ---------------- SHOT ANIMATION ---------------- */
  const handleShotAnimationEnd = async (event) => {
    if (event.target !== event.currentTarget || !shot) return;

    if (shot.phase === "flight") {
      setShot((previous) => (previous ? { ...previous, phase: "net" } : null));
      return;
    }
    if (shot.phase === "net") {
      setShot((previous) => (previous ? { ...previous, phase: "landing" } : null));
      return;
    }
    if (shot.phase !== "landing") return;

    const landedFile = files.find((item) => item.id === shot.id);
    if (!landedFile) {
      setShot(null);
      setProcessing(false);
      return;
    }
    const fileId = landedFile.id;

    setFiles((previous) =>
      previous.map((item) => (item.id === fileId ? { ...item, status: "CHECKING" } : item))
    );
    setShot(null);

    try {
      let result;
      if (["image/png", "image/jpeg", "image/webp"].includes(landedFile.type)) {
        const ocrResult = await readReceiptImage(landedFile.originalFile);
        result = {
          status: "PENDING",
          message:
            "Receipt submitted and OCR completed. Extracted details require review. OCR alone cannot confirm that the payment was received.",
          amount: ocrResult?.amount || "",
          reference: ocrResult?.reference || "",
          date: ocrResult?.date || "",
          time: ocrResult?.time || "",
          rawText: ocrResult?.rawText || "",
          confidence: ocrResult?.confidence ?? null,
        };
      } else {
        result = {
          status: "PENDING",
          message:
            "PDF receipt submitted. Image OCR is not available for this PDF. Payment verification is still pending.",
        };
      }

      const verdict = buildVerdict({ ...landedFile, result }, bankTransactions);
      result = { ...result, ...verdict };

      const updatedFile = { ...landedFile, status: verdict.status, result };
      setFiles((previous) => previous.map((item) => (item.id === fileId ? updatedFile : item)));
      setDetail(updatedFile);
    } catch (error) {
      console.error("Receipt OCR failed:", error);
      const updatedFile = {
        ...landedFile,
        status: "PENDING",
        result: {
          status: "PENDING",
          message:
            "Receipt submitted, but OCR could not read the file. Please review the receipt manually. Payment has not been verified.",
        },
      };
      setFiles((previous) => previous.map((item) => (item.id === fileId ? updatedFile : item)));
      setDetail(updatedFile);
    } finally {
      setProcessing(false);
    }
  };

  /* ---------------- POINTER EVENTS ---------------- */
  useEffect(() => {
    const move = (event) => {
      const current = dragRef.current;
      if (!current) return;

      const distance = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);
      const next = { ...current, x: event.clientX, y: event.clientY, moved: distance >= 25 };
      dragRef.current = next;
      setDrag(next);

      if (basketRef.current) {
        const rect = basketRef.current.getBoundingClientRect();
        const centerX = event.clientX - current.offsetX + current.width / 2;
        const centerY = event.clientY - current.offsetY + current.height / 2;
        setAiming(
          centerX >= rect.left + 18 &&
            centerX <= rect.right - 18 &&
            centerY >= rect.top - 5 &&
            centerY <= rect.top + 35
        );
      }
    };

    const up = () => {
      const current = dragRef.current;
      if (!current) return;
      dragRef.current = null;
      setDrag(null);
      setAiming(false);

      const distance = Math.hypot(current.x - current.startX, current.y - current.startY);
      // A click or double-click alone does not shoot.
      if (distance < 25) return;

      // Any real drag followed by release submits the shot.
      const rect = basketRef.current?.getBoundingClientRect();
      if (rect) submitShot(current.id, current, rect);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [files, processing]);

  /* ---------------- EDIT AMOUNT + RECHECK ---------------- */
  const saveEditedAmount = () => {
    const cleaned = amountDraft.replace(/[^0-9.]/g, "");
    if (!cleaned || !(Number(cleaned) > 0)) {
      window.alert("Please enter a valid amount.");
      return;
    }
    const receipt = files.find((f) => f.id === detail?.id);
    if (!receipt) return;

    const oldStatus = receipt.status;
    const newAmount = String(Number(cleaned));
    const newResult = {
      ...(receipt.result || {}),
      amount: newAmount,
      amountEdited: true,
    };

    // Re-check against the imported bank statement with the new amount
    const verdict = buildVerdict({ ...receipt, result: newResult }, bankTransactions);

    const updated = {
      ...receipt,
      status: verdict.status,
      result: { ...newResult, ...verdict },
    };

    setFiles((prev) => prev.map((f) => (f.id === receipt.id ? updated : f)));
    setDetail(updated);
    setEditingAmount(false);

    setRecheckNote(
      bankTransactions.length === 0
        ? "No bank statement is imported yet, so this receipt could not be re-verified. Import a statement first."
        : oldStatus === verdict.status
        ? `Rechecked with Rs. ${newAmount}. Status is still ${verdict.status}.`
        : `Rechecked with Rs. ${newAmount}. Status changed: ${oldStatus} → ${verdict.status}.`
    );
  };

  /* ---------------- REMOVE RECEIPT ---------------- */
  const removeFile = async (id) => {
    try {
      await deleteReceipt(id);
    } catch (error) {
      console.error("Could not delete saved receipt:", error);
      setStorageError("Could not delete the saved receipt.");
      return;
    }
    const removed = files.find((file) => file.id === id);
    if (removed?.preview) {
      URL.revokeObjectURL(removed.preview);
      urlsRef.current.delete(removed.preview);
    }
    setFiles((previous) => previous.filter((file) => file.id !== id));
    if (activeId === id) setActiveId(null);
    if (detail?.id === id) setDetail(null);
  };

  /* ---------------- REPORT DATA ---------------- */
  const total = files.length;
  const matched = files.filter(
    (file) => file.status === "MATCH" || file.result?.status === "MATCH"
  ).length;
  const mismatched = files.filter(
    (file) => file.status === "MISMATCH" || file.result?.status === "MISMATCH"
  ).length;
  const pending = files.filter((file) =>
    ["PENDING", "REVIEW"].includes(file.status || file.result?.status)
  ).length;
  const filtered = files.filter((file) =>
    file.name.toLowerCase().includes(search.toLowerCase())
  );

  const isDetailMatch = detail?.status === "MATCH";

  /* ---------------- UI ---------------- */
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand-lockup" onClick={() => setPage("upload")}>
          <span className="brand-symbol">S</span>
          <span className="brand-copy">
            <strong>SEYAL</strong>
            <small>PAYMENT OPERATIONS</small>
          </span>
        </button>

        <div className="nav-caption">WORKSPACE</div>
        <nav className="side-navigation">
          <button
            className={`nav-item ${page === "upload" ? "nav-active" : ""}`}
            onClick={() => setPage("upload")}
          >
            <Icon name="upload" />
            <span>Upload files</span>
            {total > 0 && <span className="nav-count">{total}</span>}
          </button>
          <button
            className={`nav-item ${page === "reports" ? "nav-active" : ""}`}
            onClick={() => setPage("reports")}
          >
            <Icon name="report" />
            <span>Reports</span>
          </button>
        </nav>

        <div className="sidebar-spacer" />

        <div className="sidebar-security">
          <Icon name="shield" />
          <div>
            <strong>Secure workspace</strong>
            <p>Payment data deserves protection.</p>
          </div>
        </div>

        <div className="sidebar-footer">
          <span className="footer-status-dot" /> SEYAL
          <span className="footer-version">v1.0</span>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Workspace</span>
            <span>/</span>
            <strong>{page === "upload" ? "Upload files" : "Reports"}</strong>
          </div>
          <div className="topbar-right">
            <span className="secure-chip">
              <Icon name="shield" size={15} /> Secure environment
            </span>
            <div className="user-avatar">S</div>
          </div>
        </header>

        <main className="page-content">
          {storageError && (
            <div
              role="alert"
              style={{
                padding: "12px 16px",
                marginBottom: 16,
                borderRadius: 10,
                background: "#fff3e0",
                color: "#854d0e",
              }}
            >
              {storageError}
            </div>
          )}

          {!storageReady && !storageError && <p>Loading your saved receipts…</p>}

          {page === "upload" ? (
            <>
              <section className="page-title-row">
                <div>
                  <div className="eyebrow">SEYAL • PAYMENT VERIFICATION</div>
                  <h1>Make the payment shot.</h1>
                  <p className="page-description">
                    Pick up your receipt. Aim for the hoop. Drop to submit.
                  </p>
                </div>
                <button
                  className="primary-button"
                  onClick={() => inputRef.current?.click()}
                  disabled={!storageReady}
                >
                  <Icon name="plus" /> Choose file
                </button>
              </section>

              <input
                ref={inputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,application/pdf"
                multiple
                hidden
                onChange={(event) => {
                  addFiles(event.target.files);
                  event.target.value = "";
                }}
              />

              <section className="statement-import-panel">
                <div className="statement-panel-heading">
                  <div>
                    <div className="eyebrow">BANK DATA • MANUAL IMPORT</div>
                    <h2>Import bank statement</h2>
                    <p>
                      Import Federal Bank or Canara Bank transactions first. Receipt
                      screenshots will then be checked against incoming credits.
                    </p>
                  </div>
                  <div className="statement-count">
                    {bankTransactions.length} transactions saved
                  </div>
                </div>

                <div className="statement-controls">
                  <label>
                    <span>Bank</span>
                    <select value={bank} onChange={(event) => setBank(event.target.value)}>
                      <option value="Federal Bank">Federal Bank</option>
                      <option value="Canara Bank">Canara Bank</option>
                    </select>
                  </label>

                  <label>
                    <span>Statement period</span>
                    <select value={period} onChange={(event) => setPeriod(event.target.value)}>
                      <option value="daily">Day-wise</option>
                      <option value="monthly">Month-wise</option>
                      <option value="yearly">Year-wise</option>
                      <option value="custom">Custom date range</option>
                    </select>
                  </label>

                  {period === "daily" && (
                    <label>
                      <span>Date</span>
                      <input type="date" value={periodDate} onChange={(event) => setPeriodDate(event.target.value)} />
                    </label>
                  )}
                  {period === "monthly" && (
                    <label>
                      <span>Month</span>
                      <input type="month" value={periodDate.slice(0, 7)} onChange={(event) => setPeriodDate(`${event.target.value}-01`)} />
                    </label>
                  )}
                  {period === "yearly" && (
                    <label>
                      <span>Year</span>
                      <input type="number" min="2000" max="2100" value={periodDate.slice(0, 4)} onChange={(event) => setPeriodDate(`${event.target.value}-01-01`)} />
                    </label>
                  )}
                  {period === "custom" && (
                    <>
                      <label>
                        <span>From</span>
                        <input type="date" value={customStart} onChange={(event) => setCustomStart(event.target.value)} />
                      </label>
                      <label>
                        <span>To</span>
                        <input type="date" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} />
                      </label>
                    </>
                  )}

                  <input
                    ref={statementInputRef}
                    type="file"
                    accept=".pdf,.csv,.xls,.xlsx,application/pdf,text/csv"
                    hidden
                    onChange={handleStatementImport}
                  />
                  <button
                    className="primary-button statement-import-button"
                    onClick={() => statementInputRef.current?.click()}
                    disabled={statementBusy || !storageReady}
                  >
                    <Icon name="upload" />
                    {statementBusy ? "Importing..." : "Choose statement"}
                  </button>
                </div>

                <div className="statement-footnote">
                  Accepted: PDF, CSV, XLS and XLSX. Expected columns: Txn Date, Value Date,
                  Cheque No., Description, Branch Code, Debit, Credit, Balance. Scanned
                  image-only PDFs are not supported by this parser.
                </div>

                {statementMessage && (
                  <div className="statement-message" role="status">
                    {statementMessage}
                  </div>
                )}

                {bankTransactions.length > 0 && (
                  <div className="statement-summary">
                    <span><strong>{bankTransactions.filter((row) => row.bank === "Federal Bank").length}</strong> Federal Bank rows</span>
                    <span><strong>{bankTransactions.filter((row) => row.bank === "Canara Bank").length}</strong> Canara Bank rows</span>
                    <span>Exact reference + amount + incoming credit = MATCH. Amount/date only = REVIEW.</span>
                  </div>
                )}
              </section>

              <section className="game-panel">
                <div className="panel-heading">
                  <div>
                    <h2>Payment court</h2>
                    <p>Hold a receipt card and drag it through the hoop.</p>
                  </div>
                  <div className="uploaded-counter">
                    <span className="counter-dot" />
                    Uploaded <strong>{total}</strong>
                  </div>
                </div>

                <div className="game-court">
                  <div className="court-upload">
                    <button className="upload-dropzone" onClick={() => inputRef.current?.click()}>
                      <span className="upload-icon">
                        <Icon name="upload" size={24} />
                      </span>
                      <strong>Choose your receipt</strong>
                      <span className="dropzone-secondary">Browse a screenshot or PDF</span>
                      <span className="file-formats">PNG · JPG · WEBP · PDF</span>
                    </button>
                  </div>

                  <div className="court-floor-lines">
                    <span /><span /><span />
                  </div>

                  <div className="basket-stage">
                    <div className="backboard">
                      <div className="backboard-square" />
                    </div>
                    <div
                      ref={basketRef}
                      className={`basket-target ${aiming ? "basket-over" : ""} ${
                        activeFile?.status === "CHECKING" ? "basket-processing" : ""
                      }`}
                    >
                      <div className="basket-rim" />
                      <div className="basket-net">
                        <i /><i /><i /><i /><i /><i /><i />
                      </div>
                    </div>
                  </div>

                  <div className="aim-hint">
                    <span className="aim-hint-dot" />
                    {aiming
                      ? "NICE AIM — RELEASE TO SCORE"
                      : drag
                      ? "KEEP DRAGGING • RELEASE TO SHOOT"
                      : activeFile?.status === "PENDING"
                      ? "SHOT RECEIVED • VERIFICATION PENDING"
                      : "CLICK & HOLD A RECEIPT BELOW • DRAG TO SHOOT"}
                  </div>
                </div>

                {drag && draggedFile && (
                  <div className="aim-trajectory" aria-hidden="true">
                    {Array.from({ length: 13 }, (_, index) => {
                      const t = (index + 1) / 14;
                      const rect = basketRef.current?.getBoundingClientRect();
                      if (!rect) return null;
                      const endX = rect.left + rect.width / 2;
                      const endY = rect.top + 13;
                      return (
                        <span
                          key={index}
                          className="aim-dot"
                          style={{
                            left: drag.x + (endX - drag.x) * t,
                            top: drag.y + (endY - drag.y) * t - Math.sin(t * Math.PI) * 38,
                            opacity: 0.3 + t * 0.65,
                            transform: `translate(-50%,-50%) scale(${0.45 + t * 0.55})`,
                          }}
                        />
                      );
                    })}
                  </div>
                )}

                <div className="receipt-shelf">
                  <div className="shelf-heading">
                    <div>
                      <span className="shelf-kicker">YOUR RECEIPTS</span>
                      <h3>Pick up a file</h3>
                      <p>Press and hold a card, then drag to shoot.</p>
                    </div>
                    <span className="shelf-count">
                      {total} FILE{total === 1 ? "" : "S"}
                    </span>
                  </div>

                  {files.length === 0 ? (
                    <button className="empty-shelf" onClick={() => inputRef.current?.click()}>
                      <span className="empty-file-icon"></span>
                      <span>
                        <strong>Your first shot starts here</strong>
                        <small>
                          Choose a payment screenshot. It will appear here as a draggable card.
                        </small>
                      </span>
                      <Icon name="arrow" />
                    </button>
                  ) : (
                    <div className="file-grid">
                      {files.map((file) => (
                        <div
                          key={file.id}
                          className={`file-card ${activeId === file.id ? "file-selected" : ""} ${
                            drag?.id === file.id ? "file-being-dragged" : ""
                          } ${file.status === "MATCH" ? "file-matched" : ""}`}
                          onPointerDown={(event) => startDrag(event, file)}
                          onClick={() => {
                            if (["PENDING", "REVIEW", "MATCH", "MISMATCH"].includes(file.status)) {
                              setDetail(file);
                            }
                          }}
                        >
                          <div className="file-artwork">
                            <FileArtwork file={file} />
                          </div>
                          <div className="file-card-content">
                            <strong title={file.name}>{file.name}</strong>
                            <span>{sizeLabel(file.size)}</span>
                            <span className={`file-status status-${(file.status || "READY").toLowerCase()}`}>
                              <i />
                              {file.status === "READY"
                                ? "HOLD TO PICK UP"
                                : file.status === "SHOOTING"
                                ? "IN THE AIR..."
                                : file.status === "CHECKING"
                                ? "VERIFYING..."
                                : file.status === "MATCH"
                                ? "✓ MATCH"
                                : file.status === "REVIEW"
                                ? "REVIEW"
                                : file.status === "MISMATCH"
                                ? "MISMATCH"
                                : "PENDING"}
                            </span>
                          </div>
                          <button
                            className="remove-file"
                            title="Remove file"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation();
                              removeFile(file.id);
                            }}
                          >
                            <Icon name="close" size={15} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {activeFile &&
                  ["PENDING", "REVIEW", "MATCH", "MISMATCH"].includes(activeFile.status) && (
                    <div
                      className={`verification-result ${
                        activeFile.status === "MATCH" ? "result-match" : ""
                      }`}
                    >
                      <div className="result-icon">
                        <Icon name={activeFile.status === "MATCH" ? "check" : "clock"} size={22} />
                      </div>
                      <div className="result-copy">
                        <div className="result-heading-row">
                          <h3>
                            {activeFile.status === "MATCH"
                              ? "Payment matched"
                              : activeFile.status === "REVIEW"
                              ? "Manual review required"
                              : activeFile.status === "MISMATCH"
                              ? "Payment mismatch"
                              : "Receipt submitted"}
                          </h3>
                          <span className="result-pill">{activeFile.status}</span>
                        </div>
                        <p>{activeFile.result?.message}</p>
                        <button className="result-detail-link" onClick={() => setDetail(activeFile)}>
                          View details <Icon name="arrow" size={14} />
                        </button>
                      </div>
                    </div>
                  )}
              </section>

              <div className="bottom-note">
                <Icon name="shield" size={16} />
                <span>
                  A successful shot submits the receipt; it does not confirm that the payment
                  was received. Real verification requires connected OCR and authorized
                  transaction data.
                </span>
              </div>
            </>
          ) : (
            <>
              <section className="page-title-row">
                <div>
                  <div className="eyebrow">BUSINESS INSIGHTS</div>
                  <h1>Payment reports</h1>
                  <p className="page-description">
                    Review submitted receipts and their verification status.
                  </p>
                </div>
                <div className="report-actions">
                  <button className="secondary-button" onClick={() => window.print()}>
                    <Icon name="print" /> Print report
                  </button>
                  <button className="primary-button" onClick={() => setPage("upload")}>
                    <Icon name="plus" /> Upload files
                  </button>
                </div>
              </section>

              <section className="report-stat-grid">
                <div className="report-stat">
                  <div className="stat-topline">
                    Total uploaded
                    <span className="stat-icon blue-stat"><Icon name="file" /></span>
                  </div>
                  <strong>{total}</strong>
                  <small>Saved receipts</small>
                </div>
                <div className="report-stat">
                  <div className="stat-topline">
                    Matched
                    <span className="stat-icon green-stat"><Icon name="shield" /></span>
                  </div>
                  <strong>{matched}</strong>
                  <small>Confirmed matches only</small>
                </div>
                <div className="report-stat">
                  <div className="stat-topline">
                    Mismatched
                    <span className="stat-icon red-stat"><Icon name="close" /></span>
                  </div>
                  <strong>{mismatched}</strong>
                  <small>Items requiring review</small>
                </div>
                <div className="report-stat">
                  <div className="stat-topline">
                    Pending
                    <span className="stat-icon amber-stat"><Icon name="clock" /></span>
                  </div>
                  <strong>{pending}</strong>
                  <small>Awaiting verification</small>
                </div>
              </section>

              <section className="reports-table-panel">
                <div className="table-panel-header">
                  <div>
                    <h2>Receipt submissions</h2>
                    <p>Use Print report to print or save as PDF.</p>
                  </div>
                  <label className="table-search">
                    <Icon name="search" size={17} />
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search files"
                    />
                  </label>
                </div>

                {filtered.length === 0 ? (
                  <div className="empty-reports">
                    <span className="empty-file-icon"><Icon name="file" size={26} /></span>
                    <h3>{files.length ? "No matching files" : "No reports yet"}</h3>
                    <p>
                      {files.length
                        ? "Try another file name."
                        : "Upload a receipt to see submissions here."}
                    </p>
                  </div>
                ) : (
                  <div className="table-scroll">
                    <table className="reports-table">
                      <thead>
                        <tr>
                          <th>FILE</th>
                          <th>DATE ADDED</th>
                          <th>SIZE</th>
                          <th>STATUS</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map((file) => (
                          <tr key={file.id}>
                            <td>
                              <div className="table-file">
                                <span className="table-file-icon"><Icon name="file" size={17} /></span>
                                <strong>{file.name}</strong>
                              </div>
                            </td>
                            <td>{file.addedAt}</td>
                            <td>{sizeLabel(file.size)}</td>
                            <td>
                              <span className={`table-status status-${(file.status || "READY").toLowerCase()}`}>
                                <i />
                                {file.status}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <div className="reports-disclaimer">
                <Icon name="shield" size={17} />
                <span>
                  Receipts are stored locally in this browser. OCR and live bank verification
                  are not connected yet.
                </span>
              </div>
            </>
          )}

          <footer className="page-footer">
            <span>© {new Date().getFullYear()} SEYAL</span>
            <span>Payment operations workspace</span>
          </footer>
        </main>
      </div>

      {/* DRAGGED RECEIPT */}
      {drag && draggedFile && (
        <div
          className={`drag-ghost ${aiming ? "drag-ghost-aim" : ""}`}
          style={{
            left: drag.x - drag.offsetX,
            top: drag.y - drag.offsetY,
            width: drag.width,
            height: drag.height,
            transform: `rotate(${Math.max(-9, Math.min(9, (drag.x - drag.startX) * 0.08))}deg) scale(1.06)`,
          }}
          aria-hidden="true"
        >
          <div className="file-artwork">
            <FileArtwork file={draggedFile} />
          </div>
          <div className="file-card-content">
            <strong>{draggedFile.name}</strong>
            <span>{sizeLabel(draggedFile.size)}</span>
            <span className="file-status">
              <i /> AIM FOR THE HOOP
            </span>
          </div>
        </div>
      )}

      {/* BASKETBALL SHOT ANIMATION */}
      {shot &&
        (() => {
          const shotFile = files.find((item) => item.id === shot.id);
          if (!shotFile) return null;
          return (
            <div
              key={`${shot.id}-${shot.phase}`}
              className={`shot-receipt shot-${shot.phase}`}
              onAnimationEnd={handleShotAnimationEnd}
              style={{
                "--start-x": `${shot.startX}px`,
                "--start-y": `${shot.startY}px`,
                "--basket-x": `${shot.basketX}px`,
                "--basket-y": `${shot.basketY}px`,
                "--mid-x": `${(shot.startX + shot.basketX) / 2}px`,
                "--landing-x": `${shot.landingX}px`,
                "--landing-y": `${shot.landingY}px`,
                "--receipt-width": `${shot.width}px`,
                "--receipt-height": `${shot.height}px`,
              }}
              aria-hidden="true"
            >
              <div className="shot-receipt-inner">
                <FileArtwork file={shotFile} />
              </div>
            </div>
          );
        })()}

      {/* DETAILS MODAL */}
      {detail && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDetail(null);
          }}
        >
          <section
            className={`detail-modal ${isDetailMatch ? "detail-modal-match" : ""}`}
            role="dialog"
            aria-modal="true"
          >
            <div className="modal-header">
              <div>
                <div className="eyebrow">FILE INFORMATION</div>
                <h2>Submission details</h2>
              </div>
              <button className="modal-close" onClick={() => setDetail(null)}>
                <Icon name="close" />
              </button>
            </div>

            {/* green MATCH banner */}
            {isDetailMatch && (
              <div className="match-banner">
                <span className="match-check">
                  <Icon name="check" size={22} />
                </span>
                <div>
                  <strong>Payment Matched</strong>
                  <small>Amount confirmed against an incoming bank credit</small>
                </div>
                <span className="match-shine" />
              </div>
            )}

            <div className="modal-file-preview">
              <div className="modal-art">
                <FileArtwork file={detail} />
              </div>
              <div>
                <strong>{detail.name}</strong>
                <span>{sizeLabel(detail.size)}</span>
              </div>
            </div>

            <div className="detail-rows">
              <div>
                <span>Uploaded</span>
                <strong>{detail.addedAt}</strong>
              </div>
              <div>
                <span>Workflow status</span>
                <strong>{detail.status}</strong>
              </div>
              <div>
                <span>Verification</span>
                <strong>{detail.result?.status || "NOT VERIFIED"}</strong>
              </div>
            </div>

            <div className="modal-notice">
              <Icon name="shield" />
              <p>
                {detail.result?.message ||
                  "Connect OCR and the authorized bank API to obtain a real transaction result."}
              </p>
            </div>

            {/* OCR EXTRACTED DETAILS (always shown once a result exists, so amount can be edited even for PDFs) */}
            {detail.result && (
              <div className="ocr-details">
                <h3>Extracted Receipt Details</h3>

                <div className="ocr-formatted-details">
                  {/* editable amount */}
                  <p className={`amount-row ${isDetailMatch ? "amount-matched" : ""}`}>
                    <span>1. Amount:</span>

                    {editingAmount ? (
                      <span className="amount-edit">
                        <input
                          type="text"
                          inputMode="decimal"
                          autoFocus
                          value={amountDraft}
                          onChange={(e) => setAmountDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveEditedAmount();
                            if (e.key === "Escape") setEditingAmount(false);
                          }}
                          placeholder="e.g. 1500.00"
                        />
                        <button className="amount-save" onClick={saveEditedAmount}>
                          Save
                        </button>
                        <button className="amount-cancel" onClick={() => setEditingAmount(false)}>
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <strong>
                        {detail.result.amount ? `Rs. ${detail.result.amount}` : "Not detected"}
                        {detail.result.amountEdited && <em className="edited-tag">edited</em>}
                        <button
                          className="amount-edit-btn"
                          onClick={() => {
                            setAmountDraft(String(detail.result.amount || ""));
                            setEditingAmount(true);
                          }}
                        >
                          ✏️ Edit
                        </button>
                      </strong>
                    )}
                  </p>

                  {/* recheck feedback after amount edit */}
                  {recheckNote && (
                    <div className={`recheck-note recheck-${(detail.status || "").toLowerCase()}`}>
                      {recheckNote}
                    </div>
                  )}

                  <p>
                    <span>2. Transaction Reference:</span>
                    <strong>{detail.result.reference || "Not detected"}</strong>
                  </p>
                  <p>
                    <span>3. Transaction Date:</span>
                    <strong>{detail.result.date || "Not detected"}</strong>
                  </p>
                  <p>
                    <span>4. Transaction Time:</span>
                    <strong>{detail.result.time || "Not detected"}</strong>
                  </p>
                  <p>
                    <span>5. OCR Confidence:</span>
                    <strong>
                      {detail.result.confidence != null
                        ? `${Math.round(detail.result.confidence)}%`
                        : "Not available"}
                    </strong>
                  </p>
                </div>

                {detail.result.rawText && (
                  <details className="ocr-raw-text">
                    <summary>View extracted text</summary>
                    <pre>{detail.result.rawText}</pre>
                  </details>
                )}
              </div>
            )}

            <style>{`
              .same-amount-entries { margin: 18px 0; padding: 18px; border: 1px solid #dbe5f0; border-radius: 14px; background: #fff; }
              .same-amount-entries h3 { margin: 0 0 8px; color: #16345b; font-size: 18px; }
              .same-amount-caption { margin: 0 0 12px; color: #65758b; font-size: 13px; }
              .same-amount-table-wrap { width: 100%; overflow-x: auto; }
              .same-amount-table { width: 100%; min-width: 620px; border-collapse: collapse; font-size: 12px; }
              .same-amount-table th { padding: 10px 8px; background: #0799c5; color: #fff; text-align: left; white-space: nowrap; }
              .same-amount-table td { padding: 10px 8px; border-bottom: 1px solid #e5ebf2; color: #24364b; vertical-align: top; }
              .same-amount-table tbody tr:nth-child(even) { background: #f7fafc; }
            `}</style>

            {detail.result?.amount &&
              (() => {
                const receiptAmount = parseMoney(detail.result.amount);
                const sameAmountEntries = (bankTransactions || []).filter((txn) => {
                  const incoming = incomingAmountOf(txn);
                  return incoming > 0 && Math.abs(incoming - receiptAmount) < 0.01;
                });

                return (
                  <section className="same-amount-entries">
                    <h3>Same-Amount Bank Entries</h3>
                    <p className="same-amount-caption">
                      {sameAmountEntries.length
                        ? `${sameAmountEntries.length} incoming entries found. Listed in the same order as the imported bank statement.`
                        : "No incoming bank entries with this exact amount were found."}
                    </p>
                    {sameAmountEntries.length > 0 && (
                      <div className="same-amount-table-wrap">
                        <table className="same-amount-table">
                          <thead>
                            <tr>
                              <th>Txn Date</th>
                              <th>Credit</th>
                              <th>Reference</th>
                              <th>Description</th>
                              <th>Balance</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sameAmountEntries.map((txn, index) => (
                              <tr key={txn.id || `${txn.txnDate || txn.date || "txn"}-${index}`}>
                                <td>{txn.txnDate || txn.date || txn.transactionDate || txn.valueDate || "Not detected"}</td>
                                <td>{formatReceiptAmount(txn.credit ?? txn.creditAmount ?? txn.amount)}</td>
                                <td>{txn.reference || txn.utr || txn.chequeNo || txn.transactionId || "Not available"}</td>
                                <td>{txn.description || txn.narration || "Not available"}</td>
                                <td>{txn.balance != null && txn.balance !== "" ? formatReceiptAmount(txn.balance) : "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>
                );
              })()}

            <button className="primary-button modal-done" onClick={() => setDetail(null)}>
              Done
            </button>
          </section>
        </div>
      )}
    </div>
  );
}