/**
 * 纯随机占位符生成模块
 *
 * 使用 crypto.getRandomValues() 生成不可预测的占位符。
 * 不再使用传统的有序编号格式（如 PER_001），从根本上杜绝推断。
 */

/**
 * 生成一个 8 位十六进制随机占位符
 * 使用 crypto.getRandomValues() 确保不可预测性
 */
export function generatePlaceholder(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 生成带类型前缀的占位符，便于日志调试和 AI 语义分析
 * @param type 实体类型标识，如 'PER', 'MOB', 'ID'
 * @returns 格式如 'PER_a8f3d9e2b1c4e7f0'
 */
export function generateTypedPlaceholder(type: string): string {
  const random = generatePlaceholder();
  return `${type}_${random}`;
}