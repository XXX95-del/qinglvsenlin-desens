/**
 * 映射元数据模块
 *
 * 为脱敏后的数据提供结构化语义信息，
 * 使 AI 在不接触原文的基础上完成有意义的推理分析。
 */

import type { MappingEntry } from './desensitize-engine';

/** 法律角色枚举 */
export const LEGAL_ROLES = [
  'plaintiff',
  'defendant',
  'agent',
  'witness',
  'creditor',
  'debtor',
  'guarantor',
  'third_party',
  'executor',
  'appellant',
  'appellee',
  'victim',
  'suspect',
  'lawyer',
] as const;

export type LegalRole = (typeof LEGAL_ROLES)[number];

/** 关系类型枚举 */
export const RELATION_TYPES = [
  'contract',
  'payment',
  'guarantee',
  'agency',
  'employment',
  'family',
  'property',
  'tort',
  'inheritance',
  'partnership',
] as const;

export type RelationType = (typeof RELATION_TYPES)[number];

/** 元数据 */
export interface Metadata {
  /** 实体类型 */
  entityType: string;
  /** 法律角色 */
  role?: LegalRole;
  /** 语义标签 */
  semanticLabel?: string;
  /** 关联关系 */
  relations?: Array<{
    target: string;
    type: RelationType;
  }>;
}

/**
 * 构建元数据
 * @param original 原文
 * @param type 实体类型
 * @param context 上下文文本（用于角色识别）
 * @returns 元数据
 */
export function buildMetadata(
  original: string,
  type: string,
  context?: string
): Metadata {
  const metadata: Metadata = {
    entityType: type,
  };

  if (context) {
    const role = inferRole(context, original);
    if (role) {
      metadata.role = role;
    }
  }

  return metadata;
}

/**
 * 通过上下文分析推断法律角色
 */
export function inferRole(context: string, entityName: string): LegalRole | null {
  const rolePatterns: Array<{ role: LegalRole; patterns: string[] }> = [
    { role: 'plaintiff', patterns: ['原告', '起诉人', '申诉人', 'plaintiff'] },
    { role: 'defendant', patterns: ['被告', '被申诉人', 'defendant'] },
    { role: 'agent', patterns: ['代理人', '律师', '代理律师', 'agent'] },
    { role: 'witness', patterns: ['证人', '见证人', 'witness'] },
    { role: 'creditor', patterns: ['债权人', '出借人', 'creditor'] },
    { role: 'debtor', patterns: ['债务人', '借款人', 'debtor'] },
    { role: 'guarantor', patterns: ['担保人', '保证人', 'guarantor'] },
    { role: 'third_party', patterns: ['第三人', '第三方', 'third_party'] },
    { role: 'appellant', patterns: ['上诉人', 'appellant'] },
    { role: 'appellee', patterns: ['被上诉人', 'appellee'] },
    { role: 'victim', patterns: ['受害人', '被害人', 'victim'] },
    { role: 'suspect', patterns: ['嫌疑人', '犯罪嫌疑人', 'suspect'] },
    { role: 'lawyer', patterns: ['律师', 'lawyer'] },
  ];

  for (const { role, patterns } of rolePatterns) {
    for (const pattern of patterns) {
      if (context.includes(pattern) || context.includes(entityName + pattern)) {
        return role;
      }
    }
  }

  return null;
}

/**
 * 为映射条目附加元数据
 */
export function attachMetadata(
  entry: MappingEntry,
  metadata: Metadata
): MappingEntry {
  return {
    ...entry,
    metadata: {
      entityType: metadata.entityType,
      ...(metadata.role && { role: metadata.role }),
      ...(metadata.semanticLabel && { semanticLabel: metadata.semanticLabel }),
    },
  };
}

/**
 * 从映射条目中提取元数据用于 AI 推理
 * @param entries 映射条目列表
 * @returns AI 可读的结构化元数据
 */
export function extractMetadataForAI(entries: MappingEntry[]): string {
  const parts = entries.map(entry => {
    const meta = entry.metadata || {};
    const parts = [`${entry.placeholder} -> [${entry.type}]`];
    if (meta.role) parts.push(`角色:${meta.role}`);
    if (meta.semanticLabel) parts.push(`标签:${meta.semanticLabel}`);
    return parts.join(' ');
  });

  return parts.join('\n');
}