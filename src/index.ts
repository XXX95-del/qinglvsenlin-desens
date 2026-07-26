/**
 * 基于客户端零信任架构的数据脱敏系统
 *
 * 在浏览器端完成敏感数据识别、脱敏与还原，
 * 服务器端仅存储加密后的数据，无法还原原始信息。
 * 支持跨案件隔离、AES-256-GCM 加密、云端同步。
 */

// 核心引擎
export {
  DesensitizeEngine,
  type MappingEntry,
  type DesensitizeResult,
  type DesensitizeOptions,
  type Detector,
} from './desensitize-engine';

// 加密模块
export {
  deriveKeyFromPassword,
  generateSalt,
  encrypt,
  decrypt,
  serializePayload,
  deserializePayload,
  setSessionKey,
  getSessionKey,
  clearSessionKey,
  type EncryptedPayload,
} from './mapping-crypto';

// 随机占位符
export { generatePlaceholder, generateTypedPlaceholder } from './random-placeholder';

// 元数据系统
export {
  buildMetadata,
  inferRole,
  attachMetadata,
  extractMetadataForAI,
  LEGAL_ROLES,
  RELATION_TYPES,
  type Metadata,
  type LegalRole,
  type RelationType,
} from './mapping-metadata';

// 云端同步
export {
  onLogin,
  onMappingChange,
  onLogout,
  type SyncAdapter,
} from './mapping-sync';

// 全局拦截器
export { AuthInterceptor, type InterceptorConfig } from './auth-interceptor';