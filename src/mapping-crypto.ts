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
    false,
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

/**
 * 设置会话密钥（登录时调用）
 */
export function setSessionKey(key: CryptoKey): void {
  sessionKey = key;
}

/**
 * 获取会话密钥
 */
export function getSessionKey(): CryptoKey | null {
  return sessionKey;
}

/**
 * 清除会话密钥（登出时调用）
 */
export function clearSessionKey(): void {
  sessionKey = null;
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