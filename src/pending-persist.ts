import type { MappingEntry } from './desensitize-engine';

/**
 * 待同步映射（pendingSync）的浏览器持久化层。
 *
 * 目标：解决「脱敏产生映射后，页面刷新即丢失未同步映射」的问题。
 * - 浏览器环境：写入 IndexedDB，刷新后仍可恢复重新上传；
 * - Node/测试/隐私模式等无 indexedDB 环境：安全降级为内存（no-op），不影响主流程。
 *
 * 所有方法均为「尽力而为」（best-effort）：任何读写失败都会被静默吞掉，
 * 绝不阻塞或抛错到脱敏/同步主链路——内存 pendingSync 始终是主数据源。
 */

const DB_NAME = 'qinglvsenlin-desens-pending';
const STORE = 'pending';
const VERSION = 1;

function getIDB(): IDBFactory | null {
  try {
    return (
      (typeof globalThis !== 'undefined' &&
        (globalThis as { indexedDB?: IDBFactory }).indexedDB) ||
      null
    );
  } catch {
    return null;
  }
}

function openDB(): Promise<IDBDatabase | null> {
  const idb = getIDB();
  if (!idb) return Promise.resolve(null);
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = idb.open(DB_NAME, VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'placeholder' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function withStore<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> {
  return new Promise((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, mode);
    } catch {
      return resolve(null);
    }
    tx.oncomplete = () => resolve(result as T | null);
    tx.onerror = () => resolve(null);
    tx.onabort = () => resolve(null);
    let result: T | null = null;
    let req: IDBRequest<T>;
    try {
      req = fn(tx.objectStore(STORE));
    } catch {
      return resolve(null);
    }
    req.onsuccess = () => {
      result = req.result;
    };
    req.onerror = () => {
      // 读取失败：置 null，事务 abort 时 resolve(null)
    };
  });
}

/** 读取全部待同步映射（未按任何顺序保证） */
export async function readPendingStore(): Promise<MappingEntry[]> {
  const db = await openDB();
  if (!db) return [];
  try {
    const rows = await withStore(db, 'readonly', (s) => s.getAll() as IDBRequest<MappingEntry[]>);
    return Array.isArray(rows) ? rows : [];
  } finally {
    db.close();
  }
}

/** 写入/更新一条待同步映射 */
export async function upsertPendingStore(entry: MappingEntry): Promise<void> {
  const db = await openDB();
  if (!db) return;
  try {
    await withStore(db, 'readwrite', (s) => s.put(entry as unknown as { placeholder: string }));
  } finally {
    db.close();
  }
}

/** 按占位符移除一条已同步映射 */
export async function removePendingStore(placeholder: string): Promise<void> {
  const db = await openDB();
  if (!db) return;
  try {
    await withStore(db, 'readwrite', (s) => s.delete(placeholder));
  } finally {
    db.close();
  }
}

/** 清空全部待同步持久化记录 */
export async function clearPendingStore(): Promise<void> {
  const db = await openDB();
  if (!db) return;
  try {
    await withStore(db, 'readwrite', (s) => s.clear());
  } finally {
    db.close();
  }
}