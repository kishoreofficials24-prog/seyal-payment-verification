const DB_NAME = "seyal-payment-verification";
const DB_VERSION = 2;
const STORE = "bankTransactions";

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      // Existing receipt data-ai preserve pannum.
      if (!db.objectStoreNames.contains("receipts")) {
        db.createObjectStore("receipts", { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getBankTransactions() {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).getAll();

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);

    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function saveBankTransactions(rows) {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);

    rows.forEach((row) => store.put(row));

    tx.oncomplete = () => {
      db.close();
      resolve();
    };

    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };

    tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  });
}