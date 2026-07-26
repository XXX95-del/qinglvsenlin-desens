/**
 * 映射同步模块
 *
 * 管理脱敏映射表在客户端的加密存储与云端同步。
 * 支持会话密钥管理和生命周期清理。
 */

import type { MappingEntry } from './desensitize-engine';
import {
  encrypt,
  decrypt,
  deriveKeyFromPassword,
  setSessionKey,
  clearSessionKey,
  getSessionKey,
  type EncryptedPayload,
} from './mapping-crypto';

// ============================================================
// 同步接口
// ============================================================

/** 云端同步适配器：使用者需根据后端 API 实现 */
export interface SyncAdapter {
  /** 拉取加密映射数据 */
  fetchMappings(): Promise<EncryptedPayload[]>;
  /** 推送加密映射数据 */
  pushMappings(payload: EncryptedPayload): Promise<void>;
  /** 清理云端映射 */
  clearMappings(caseId?: string): Promise<void>;
}

// ============================================================
// 会话生命周期
// ============================================================

/**
 * 登录时调用：派生密钥 + 拉取云端映射 + 解密入缓存
 * @param password 用户密码
 * @param salt 盐值（从云端获取）
 * @param syncAdapter 同步适配器
 * @returns 解密后的映射条目列表
 */
export async function onLogin(
  password: string,
  salt: string,
  syncAdapter: SyncAdapter
): Promise<MappingEntry[]> {
  // 派生会话密钥
  const key = await deriveKeyFromPassword(password, salt);

  // 拉取云端加密数据
  const encryptedPayloads = await syncAdapter.fetchMappings();

  // 解密所有映射
  const mappings: MappingEntry[] = [];
  for (const payload of encryptedPayloads) {
    try {
      const json = await decrypt(payload, key);
      const entries = JSON.parse(json) as MappingEntry[];
      mappings.push(...entries);
    } catch (error) {
      console.error('Failed to decrypt mapping:', error);
    }
  }

  // 仅在成功拉取并解密后才设置会话密钥，避免半初始化状态
  setSessionKey(key);

  return mappings;
}

/**
 * 映射表变更时调用：加密 + 同步到云端
 * @param mappings 映射条目列表
 * @param syncAdapter 同步适配器
 * @param salt 盐值
 */
export async function onMappingChange(
  mappings: MappingEntry[],
  syncAdapter: SyncAdapter,
  salt: string
): Promise<void> {
  const key = getSessionKey();
  if (!key) {
    throw new Error('Session key not available. Please login first.');
  }

  const json = JSON.stringify(mappings);
  const payload = await encrypt(json, key, salt);
  await syncAdapter.pushMappings(payload);
}

/**
 * 登出时调用：清除会话密钥和缓存
 */
export function onLogout(): void {
  clearSessionKey();
}