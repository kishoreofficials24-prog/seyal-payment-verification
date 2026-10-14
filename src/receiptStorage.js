
const DB_NAME = "seyal-payment-verification";
const DB_VERSION = 2;
const STORE_NAME = "receipts";

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB is not supported in this browser."));
      return;
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains("bankTransactions")) {
        db.createObjectStore("bankTransactions", {
          keyPath: "id",
        });
      }
    };

    request.onsuccess = () => resolve(request.result);

    request.onerror = () => {
      reject(request.error || new Error("Unable to open receipt database."));
    };

    request.onblocked = () => {
      console.warn(
        "Database upgrade is blocked. Close other tabs running this app."
      );
    };
  });
}

export async function getReceipts() {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    let transaction;

    try {
      transaction = db.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).getAll();

      request.onsuccess = () => {
        const receipts = request.result || [];

        receipts.sort(
          (a, b) => (b.savedAt || 0) - (a.savedAt || 0)
        );

        resolve(receipts);
      };

      request.onerror = () => {
        reject(request.error || new Error("Could not load saved receipts."));
      };

      transaction.onabort = () => {
        reject(transaction.error || new Error("Receipt loading was aborted."));
      };
    } catch (error) {
      reject(error);
    } finally {
      db.close();
    }
  });
}

export async function saveReceipts(receipts) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    let transaction;

    try {
      transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);

      receipts.forEach((receipt) => {
        const record = {
          ...receipt,
          preview: null,
          originalFile: undefined,
          blob: receipt.originalFile || receipt.blob || null,
          savedAt: receipt.savedAt || Date.now(),
        };

        store.put(record);
      });

      transaction.oncomplete = () => resolve();

      transaction.onerror = () => {
        reject(transaction.error || new Error("Could not save receipts."));
      };

      transaction.onabort = () => {
        reject(transaction.error || new Error("Receipt save was aborted."));
      };
    } catch (error) {
      reject(error);
    } finally {
      db.close();
    }
  });
}

export async function deleteReceipt(id) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    let transaction;

    try {
      transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(id);

      transaction.oncomplete = () => resolve();

      transaction.onerror = () => {
        reject(transaction.error || new Error("Could not delete receipt."));
      };

      transaction.onabort = () => {
        reject(transaction.error || new Error("Receipt deletion was aborted."));
      };
    } catch (error) {
      reject(error);
    } finally {
      db.close();
    }
  });
}