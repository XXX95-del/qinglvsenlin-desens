/**
 * 纯随机占位符生成（零信任：随机值不可回推原文）
 * 与「网页版」保持一致的前缀 + 16 位十六进制格式：
 *   generatePlaceholder()                 -> "b3f1a9c04d7e2f6a"
 *   generateRandomPlaceholder('PER')      -> "PER_b3f1a9c04d7e2f6a"
 *   generateTypedPlaceholder('PER')       -> "PER_b3f1a9c04d7e2f6a"
 */
const PLACEHOLDER_SEPARATOR = '_'; // 占位符“类型前缀 + 十六进制”分隔符
const RANDOM_HEX_LENGTH = 16; // 8 字节 -> 16 位 hex（64bit 熵）
export { PLACEHOLDER_SEPARATOR };
const TYPE_PREFIX_WHITELIST = new Set([
  'PER', 'ORG', 'MOB', 'TEL', 'ID', 'EMAIL', 'AMT', 'DATE', 'ADD',
  'CASE_TYPE', 'CASE_NUMBER', 'BANK_ACCOUNT', 'PLATE', 'ACCOUNT', 'ENT',
]);

// 本进程内已派发过的占位符（防止生成碰撞，Session 级即可）
const usedPlaceholders = new Set<string>();

function randomHex(): string {
  const bytes = new Uint8Array(RANDOM_HEX_LENGTH / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 生成带类型前缀的占位符 `TYPE_<16hex>`；type 不在白名单时退回 `H_<16hex>` */
export function generateTypedPlaceholder(type?: string): string {
  const prefix = (type && TYPE_PREFIX_WHITELIST.has(type)) ? type : 'H';
  let p: string;
  do {
    p = `${prefix}${PLACEHOLDER_SEPARATOR}${randomHex()}`;
  } while (usedPlaceholders.has(p));
  usedPlaceholders.add(p);
  return p;
}

/** generateRandomPlaceholder 别名（与网页版命名对齐） */
export function generateRandomPlaceholder(type: string): string {
  return generateTypedPlaceholder(type);
}

/** 兼容旧签名：不带类型前缀的纯随机（不参与碰撞登记） */
export function generatePlaceholder(): string {
  return randomHex();
}

/** 解析占位符的类型前缀；非 `TYPE_xxx` 形态返回 null */
export function extractTypeFromPlaceholder(placeholder: string): string | null {
  const idx = placeholder.indexOf(PLACEHOLDER_SEPARATOR);
  if (idx < 1) return null;
  const type = placeholder.slice(0, idx);
  return TYPE_PREFIX_WHITELIST.has(type) ? type : null;
}

/** 校验是否为本库派发的随机占位符（`TYPE_<16hex>` 与 `H_<16hex>` 均合法） */
export function isRandomPlaceholder(placeholder: string): boolean {
  const idx = placeholder.indexOf(PLACEHOLDER_SEPARATOR);
  if (idx < 1) return false;
  const type = placeholder.slice(0, idx);
  const hex = placeholder.slice(idx + 1);
  if (!/^[A-Z][A-Z_]*$/.test(type)) return false;
  return new RegExp(`^[0-9a-f]{${RANDOM_HEX_LENGTH}}$`).test(hex);
}

/** 登记既有占位符（如从云端映射解密恢复后），避免后续生成碰撞 */
export function registerExistingPlaceholder(placeholder: string): void {
  if (typeof placeholder === 'string' && placeholder.length > 2) {
    usedPlaceholders.add(placeholder);
  }
}

/** 清空占位符登记表（登出时调用） */
export function clearPlaceholderRegistry(): void {
  usedPlaceholders.clear();
}