/**
 * AES-256-GCM 加密模块
 *
 * 使用 Web Crypto API 实现，不依赖任何第三方库。
 * 支持 PBKDF2 密钥派生和 AES-256-GCM 认证加密。
 */

// ============================================================
// 密钥派生
// ============================================================

/**
 * 通过 PBKDF2 从密码派生 AES-256 密钥
 * @param password 用户密码
 * @param salt 随机盐值（16 字节，hex 编码）
 * @returns CryptoKey 对象
 */
export async function deriveKeyFromPassword(
  password: string,
  salt: string
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: hexToBytes(salt) as BufferSource,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true, // extractable：为支持浏览器本地持久化（刷新恢复）而允许导出封装
    ['encrypt', 'decrypt']
  );
}

/**
 * 生成随机盐值
 * @returns 16 字节 hex 编码的盐值
 */
export function generateSalt(): string {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return bytesToHex(salt);
}

// ============================================================
// 加密 / 解密
// ============================================================

/** 加密结果载荷 */
export interface EncryptedPayload {
  /** 盐值（16 字节，hex） */
  salt: string;
  /** 初始化向量（12 字节，hex） */
  iv: string;
  /** 认证标签（16 字节，hex） */
  tag: string;
  /** 密文（base64） */
  ciphertext: string;
}

/**
 * AES-256-GCM 加密
 * @param plaintext 明文
 * @param key AES 密钥
 * @param salt 盐值（可选，不传则自动生成）
 * @returns 加密结果
 */
export async function encrypt(
  plaintext: string,
  key: CryptoKey,
  salt?: string
): Promise<EncryptedPayload> {
  const enc = new TextEncoder();
  const data = enc.encode(plaintext);
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv as BufferSource,
      tagLength: 128,
    },
    key,
    data
  );

  // GCM 输出格式：ciphertext(encrypted.length - 16) + tag(16)
  const tag = encrypted.slice(encrypted.byteLength - 16);
  const ciphertext = encrypted.slice(0, encrypted.byteLength - 16);

  return {
    salt: salt || generateSalt(),
    iv: bytesToHex(iv),
    tag: bytesToHex(new Uint8Array(tag)),
    ciphertext: arrayBufferToBase64(ciphertext),
  };
}

/**
 * AES-256-GCM 解密
 * @param payload 加密结果
 * @param key AES 密钥
 * @returns 解密后的明文
 */
export async function decrypt(
  payload: EncryptedPayload,
  key: CryptoKey
): Promise<string> {
  const iv = hexToBytes(payload.iv);
  const tag = hexToBytes(payload.tag);
  const ciphertext = base64ToArrayBuffer(payload.ciphertext);

  // GCM 输入格式：ciphertext + tag
  const combined = new Uint8Array(ciphertext.byteLength + tag.length);
  combined.set(new Uint8Array(ciphertext), 0);
  combined.set(tag, ciphertext.byteLength);

  const decrypted = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: iv as BufferSource,
      tagLength: 128,
    },
    key,
    combined as BufferSource
  );

  return new TextDecoder().decode(decrypted);
}

/**
 * 将加密载荷序列化为可存储的字符串
 * 格式：salt.iv.tag.ciphertext（全部 base64）
 */
export function serializePayload(payload: EncryptedPayload): string {
  return [
    payload.salt,
    payload.iv,
    payload.tag,
    payload.ciphertext,
  ].join('.');
}

/**
 * 从字符串反序列化加密载荷
 */
export function deserializePayload(serialized: string): EncryptedPayload {
  const parts = serialized.split('.');
  if (parts.length !== 4) {
    throw new Error('Invalid encrypted payload format');
  }
  return {
    salt: parts[0],
    iv: parts[1],
    tag: parts[2],
    ciphertext: parts[3],
  };
}

// ============================================================
// 会话密钥管理
// ============================================================

let sessionKey: CryptoKey | null = null;

// ============================================================
// 浏览器本地持久化（IndexedDB）
//
// 威胁模型：本库默认将脱敏全程放在浏览器端运行，数据不发送至服务器。
// 因此在浏览器的本地存储中持久化密钥即可满足"刷新后自动恢复"，无需每次重新输入密码。
//
// 安全取舍（务必知悉）：IndexedDB / localStorage 中的数据对**同源任意脚本（含 XSS）
// 均可见**。本实现把密钥持久化到 IndexedDB，意味着：
//   - 能防的：服务器侧窃取、跨域读取、页面关闭后数据丢失；
//   - 不能防的：同源脚本被 XSS / 恶意扩展攻破后直接读取本地密钥。
// 若你的威胁模型要求"即便同源脚本被攻破密钥也不可提取"，请改用 WebAuthn / OS-KEYCHAIN
// 托管凭据，或将本模块切换为"仅内存"策略（见下文 setSessionKey 的注释开关）。
//
// KV 存储抽象：浏览器默认走 IndexedDB；非浏览器环境（如 Node 测试）可在注入内存 KV。
// ============================================================

export interface KeyVault {
  get(id: string): Promise<string | CryptoKey | null>;
  set(id: string, value: string | CryptoKey): Promise<void>;
  remove(id: string): Promise<void>;
}

const SESSION_KV_ID = 'olasenos_session_key';

let keyVault: KeyVault | null = null;

/** 注入 KV 后端（浏览器默认 IndexedDB；测试可用内存实现替换） */
export function setKeyVaultForTest(vault?: KeyVault | null): KeyVault {
  keyVault = vault === undefined || vault === null ? memoryKeyVault() : vault;
  return keyVault;
}

/** 暴露当前 KV 后端（测试用） */
export function getKeyVaultForTest(): KeyVault | null {
  return keyVault;
}

function memoryKeyVault(): KeyVault {
  const store = new Map<string, string | CryptoKey>();
  return {
    async get(id) {
      return store.has(id) ? (store.get(id) as string | CryptoKey) : null;
    },
    async set(id, value) {
      store.set(id, value);
    },
    async remove(id) {
      store.delete(id);
    },
  };
}

function createIndexedDbKeyVault(): KeyVault {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  // 缺少 IndexedDB（如部分 worker / Node）时退化为内存，保证接口始终可用
  if (!idb) {
    return memoryKeyVault();
  }

  function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = (idb as IDBFactory).open('olasenos-desens', 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('kv')) {
          req.result.createObjectStore('kv', { keyPath: 'k' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbOp<T>(
    mode: IDBTransactionMode,
    act: (store: IDBObjectStore) => IDBRequest<T>
  ): Promise<T> {
    const db = await openDb();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction('kv', mode);
      const req = act(tx.objectStore('kv'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  return {
    get(id) {
      return idbOp<{ k: string; v: string | CryptoKey } | undefined>(
        'readonly',
        store => store.get(id)
      ).then(r => (r ? r.v : null));
    },
    set(id, value) {
      return new Promise((resolve, reject) => {
        idbOp<IDBValidKey>('readwrite', store => store.put({ k: id, v: value }))
          .then(() => resolve())
          .catch(reject);
      });
    },
    remove(id) {
      return new Promise((resolve, reject) => {
        idbOp<undefined>('readwrite', store => store.delete(id) as never)
          .then(() => resolve())
          .catch(reject);
      });
    },
  };
}

async function getKeyVault(): Promise<KeyVault> {
  if (!keyVault) {
    keyVault = createIndexedDbKeyVault();
  }
  return keyVault;
}

function bytesToBase64(bytes: Uint8Array): string {
  return arrayBufferToBase64(bytes.buffer as ArrayBuffer);
}

function base64ToB64Bytes(b64: string): Uint8Array {
  return new Uint8Array(base64ToArrayBuffer(b64));
}

/**
 * 设置会话密钥（登录派生后调用）。
 * 默认会持久化到浏览器本地（IndexedDB），刷新后可通过 restoreSessionKey() 自动恢复。
 * 若传入 persist=false 则仅保留在内存（更严格）。
 */
const DEVICE_KV_ID = 'qlsl_device_key';

/**
 * 获取（或创建）不可导出的设备密钥（AES-256-GCM）。
 * - non-extractable：浏览器内可用于加解密，任何同源脚本都无法 export 出其原始字节。
 * - 持久化到浏览器本地（IndexedDB，structured-clone 可存 CryptoKey），刷新后仍在；
 *   无 IndexedDB 环境（Node/隐私模式）退化为内存引用，仅当前进程可用。
 * 设备密钥用于「信封封装」会话密钥，保证落盘的是密文而非明文。
 */
export async function getDeviceKey(): Promise<CryptoKey | null> {
  try {
    const vault = await getKeyVault();
    const existing = await vault.get(DEVICE_KV_ID);
    if (existing instanceof CryptoKey) return existing;
    const key = (await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )) as CryptoKey;
    await vault.set(DEVICE_KV_ID, key);
    return key;
  } catch {
    return null;
  }
}

export async function setSessionKey(
  key: CryptoKey,
  persist = true
): Promise<void> {
  sessionKey = key;
  if (!persist) return;
  try {
    // 信封封装：cookie 以防下述泄——不把会话密钥明文落盘，
    // 只把「不可导出设备密钥加密后的密文」持久化到浏览器本地。
    const raw = await crypto.subtle.exportKey('raw', key);
    const dk = await getDeviceKey();
    if (!dk) return; // 设备密钥不可用则仅存内存
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dk, raw);
    await (await getKeyVault()).set(
      SESSION_KV_ID,
      bytesToBase64(iv) + ':' + bytesToBase64(new Uint8Array(ct))
    );
  } catch {
    // 持久化失败不致命：会话密钥仍保留在内存可用
  }
}

/**
 * 获取会话密钥
 */
export function getSessionKey(): CryptoKey | null {
  return sessionKey;
}

/**
 * 恢复会话密钥（页面刷新后调用）。
 * 从浏览器本地（IndexedDB）读取并还原为内存 CryptoKey。
 * @returns 是否可以继续使用会话密钥（存在且导入成功）
 */
export async function restoreSessionKey(): Promise<boolean> {
  if (sessionKey) return true;
  try {
    const stored = await (await getKeyVault()).get(SESSION_KV_ID);
    if (!stored || typeof stored !== 'string') return false;
    const sep = stored.indexOf(':');
    if (sep <= 0) return false;
    const iv = base64ToB64Bytes(stored.slice(0, sep)).buffer as ArrayBuffer;
    const ct = base64ToB64Bytes(stored.slice(sep + 1)).buffer as ArrayBuffer;
    const dk = await getDeviceKey();
    if (!dk) return false;
    const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, dk, ct);
    const key = (await crypto.subtle.importKey(
      'raw',
      raw,
      { name: 'AES-GCM' },
      true,
      ['encrypt', 'decrypt']
    )) as CryptoKey;
    sessionKey = key;
    return true;
  } catch {
    sessionKey = null;
    return false;
  }
}

/**
 * 检查会话密钥是否就绪
 */
export function isSessionKeyReady(): boolean {
  return sessionKey !== null;
}

/**
 * 清除会话密钥（登出时调用）：清空内存，并移除浏览器本地持久化副本
 */
export async function clearSessionKey(): Promise<void> {
  sessionKey = null;
  try {
    await (await getKeyVault()).remove(SESSION_KV_ID);
  } catch {
    // 忽略清理失败
  }
}

// ============================================================
// 工具函数
// ============================================================

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}