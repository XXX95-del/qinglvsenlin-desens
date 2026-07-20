/**
 * 脱敏引擎 v2.0
 *
 * 基于客户端零信任架构的数据脱敏核心模块。
 * 本文件提供脱敏引擎的架构框架和公共接口，不包含具体的敏感信息识别算法。
 * 识别算法需由使用者根据业务场景自定义实现（详见 Detector 接口）。
 */

import { generatePlaceholder } from './random-placeholder';

// ============================================================
// 类型定义
// ============================================================

/** 检测器接口：使用者可自定义实现具体的敏感信息识别逻辑 */
export interface Detector {
  /**
   * 检测文本中的敏感信息
   * @param text 原始文本
   * @returns 检测到的敏感信息列表
   */
  detect(text: string): DetectedEntity[];
}

/** 检测到的敏感信息实体 */
export interface DetectedEntity {
  /** 原文 */
  text: string;
  /** 在原文中的起始位置 */
  start: number;
  /** 在原文中的结束位置 */
  end: number;
  /** 实体类型（如 'PER', 'MOB', 'ID', 'EMAIL', 'ADD' 等） */
  type: string;
  /** 置信度（0-1） */
  confidence: number;
}

/** 映射条目 */
export interface MappingEntry {
  /** 原文 */
  original: string;
  /** 占位符 */
  placeholder: string;
  /** 案件 ID（用于跨案件隔离） */
  caseId: string;
  /** 实体类型 */
  type: string;
  /** 创建时间戳 */
  createdAt: number;
  /** 元数据（可选） */
  metadata?: Record<string, string>;
}

/** 脱敏结果 */
export interface DesensitizeResult {
  /** 脱敏后的文本 */
  text: string;
  /** 本次脱敏涉及的映射条目 */
  mappings: MappingEntry[];
}

/** 脱敏选项 */
export interface DesensitizeOptions {
  /** 案件 ID（用于跨案件隔离） */
  caseId: string;
  /** 自定义检测器（不传则不执行敏感信息检测，仅做脱敏框架） */
  detector?: Detector;
  /** 需要跳过的字段名列表 */
  skipFields?: string[];
  /** 是否对已有映射的原文进行强制重新检测 */
  forceRedetect?: boolean;
}

// ============================================================
// 脱敏引擎
// ============================================================

export class DesensitizeEngine {
  /** 映射表：MappingKey -> MappingEntry */
  private mappings: Map<string, MappingEntry> = new Map();

  /** 反向映射：占位符 -> 原文（用于还原） */
  private reverseMap: Map<string, string> = new Map();

  /** 默认跳过的字段名 */
  private defaultSkipFields = new Set([
    'status',
    'type',
    'deadline',
    'id',
    'user_id',
    'created_at',
    'updated_at',
    '__v',
    'version',
  ]);

  // ============================================================
  // 配置
  // ============================================================

  /**
   * 添加自定义跳过字段
   */
  addSkipField(field: string): void {
    this.defaultSkipFields.add(field);
  }

  /**
   * 移除跳过字段
   */
  removeSkipField(field: string): void {
    this.defaultSkipFields.delete(field);
  }

  /**
   * 设置跳过字段列表
   */
  setSkipFields(fields: string[]): void {
    this.defaultSkipFields = new Set(fields);
  }

  // ============================================================
  // 核心 API
  // ============================================================

  /**
   * 对文本执行脱敏
   * @param text 原始文本
   * @param options 脱敏选项（需包含 caseId，可选 detector）
   * @returns 脱敏结果
   */
  desensitize(text: string, options: DesensitizeOptions): DesensitizeResult {
    if (!options.caseId) {
      throw new Error('caseId is required for desensitization');
    }

    const mappings: MappingEntry[] = [];
    let result = text;

    // 如果没有检测器，直接返回原文（由使用者自定义检测逻辑）
    if (!options.detector) {
      return { text: result, mappings: [] };
    }

    // 使用检测器识别敏感信息
    const entities = options.detector.detect(text);

    // 按位置从后往前替换，避免位置偏移
    const sortedEntities = [...entities].sort((a, b) => b.start - a.start);

    for (const entity of sortedEntities) {
      const mappingKey = this.buildMappingKey(options.caseId, entity.text);

      // 查找或创建映射
      let entry = this.mappings.get(mappingKey);
      if (!entry) {
        const placeholder = this.generateAndStoreMapping(
          entity.text,
          options.caseId,
          entity.type
        );
        entry = this.mappings.get(mappingKey)!;
      }

      // 替换原文中的敏感信息为占位符
      result =
        result.substring(0, entity.start) +
        entry.placeholder +
        result.substring(entity.end);

      mappings.push(entry);
    }

    return { text: result, mappings };
  }

  /**
   * 将占位符还原为原文
   * @param text 包含占位符的文本
   * @returns 还原后的文本
   */
  restore(text: string): string {
    let result = text;

    // 替换所有已知占位符
    for (const [placeholder, original] of this.reverseMap.entries()) {
      const regex = new RegExp(placeholder, 'g');
      result = result.replace(regex, original);
    }

    return result;
  }

  /**
   * 深度遍历并脱敏对象中的所有字符串字段
   * @param obj 要脱敏的对象
   * @param options 脱敏选项
   * @returns 脱敏后的对象副本
   */
  desensitizeObject(
    obj: Record<string, unknown>,
    options: DesensitizeOptions
  ): Record<string, unknown> {
    const skipFields = new Set([
      ...this.defaultSkipFields,
      ...(options.skipFields || []),
    ]);

    return this.traverseAndDesensitize(obj, skipFields, options);
  }

  /**
   * 深度遍历并还原对象中的所有占位符
   * @param obj 包含占位符的对象
   * @returns 还原后的对象副本
   */
  restoreObject(obj: Record<string, unknown>): Record<string, unknown> {
    return JSON.parse(this.restore(JSON.stringify(obj)));
  }

  // ============================================================
  // 映射管理
  // ============================================================

  /**
   * 获取指定案件的所有映射
   */
  getCaseMappings(caseId: string): MappingEntry[] {
    const result: MappingEntry[] = [];
    for (const [key, entry] of this.mappings.entries()) {
      if (key.startsWith(caseId + '::')) {
        result.push(entry);
      }
    }
    return result;
  }

  /**
   * 获取所有映射
   */
  getAllMappings(): MappingEntry[] {
    return Array.from(this.mappings.values());
  }

  /**
   * 获取映射条目数量
   */
  getMappingCount(): number {
    return this.mappings.size;
  }

  /**
   * 清除指定案件的所有映射
   */
  clearCaseMappings(caseId: string): void {
    for (const [key, entry] of this.mappings.entries()) {
      if (entry.caseId === caseId) {
        this.mappings.delete(key);
        this.reverseMap.delete(entry.placeholder);
      }
    }
  }

  /**
   * 清除所有映射
   */
  clearAllMappings(): void {
    this.mappings.clear();
    this.reverseMap.clear();
  }

  /**
   * 批量导入映射
   */
  importMappings(entries: MappingEntry[]): void {
    for (const entry of entries) {
      const key = this.buildMappingKey(entry.caseId, entry.original);
      this.mappings.set(key, entry);
      this.reverseMap.set(entry.placeholder, entry.original);
    }
  }

  /**
   * 导出所有映射
   */
  exportMappings(): MappingEntry[] {
    return Array.from(this.mappings.values());
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * 构建映射键（跨案件隔离的核心）
   * 格式：caseId + '::' + originalText
   */
  private buildMappingKey(caseId: string, original: string): string {
    return `${caseId}::${original}`;
  }

  /**
   * 生成并存储映射
   */
  private generateAndStoreMapping(
    original: string,
    caseId: string,
    type: string
  ): string {
    const placeholder = generatePlaceholder();
    const key = this.buildMappingKey(caseId, original);

    const entry: MappingEntry = {
      original,
      placeholder,
      caseId,
      type,
      createdAt: Date.now(),
    };

    this.mappings.set(key, entry);
    this.reverseMap.set(placeholder, original);

    return placeholder;
  }

  /**
   * 递归遍历并脱敏对象
   */
  private traverseAndDesensitize(
    obj: unknown,
    skipFields: Set<string>,
    options: DesensitizeOptions
  ): any {
    if (typeof obj === 'string') {
      return this.desensitize(obj, options).text;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.traverseAndDesensitize(item, skipFields, options));
    }

    if (obj !== null && typeof obj === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        if (skipFields.has(key)) {
          result[key] = value;
        } else {
          result[key] = this.traverseAndDesensitize(value, skipFields, options);
        }
      }
      return result;
    }

    return obj;
  }
}

// ============================================================
// 便捷函数
// ============================================================

/**
 * 创建默认脱敏引擎实例
 */
export function createEngine(): DesensitizeEngine {
  return new DesensitizeEngine();
}

/**
 * 对文本执行脱敏（便捷函数）
 */
export function desensitize(
  text: string,
  options: DesensitizeOptions
): DesensitizeResult {
  const engine = new DesensitizeEngine();
  return engine.desensitize(text, options);
}

/**
 * 还原文本中的占位符（便捷函数，需先导入映射）
 */
export function restore(
  text: string,
  mappings: MappingEntry[]
): string {
  const engine = new DesensitizeEngine();
  engine.importMappings(mappings);
  return engine.restore(text);
}