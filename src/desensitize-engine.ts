/**
 * 脱敏引擎 v2.0
 *
 * 基于客户端零信任架构的数据脱敏核心模块。
 * 本文件提供脱敏引擎的架构框架和公共接口，不包含具体的敏感信息识别算法。
 * 识别算法需由使用者根据业务场景自定义实现（详见 Detector 接口）。
 */

import { generateTypedPlaceholder } from './random-placeholder';

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

  /** 待同步的新映射队列 */
  private pendingSync: MappingEntry[] = [];

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
    const seenPlaceholders = new Set<string>();
    let result = text;

    // 如果没有检测器，直接返回原文（由使用者自定义检测逻辑）
    if (!options.detector) {
      return { text: result, mappings: [] };
    }

    // 使用检测器识别敏感信息
    const entities = options.detector.detect(text);

    // 按位置从后往前替换，避免位置偏移；同一起点优先取最长区间
    //（自定义 detector 常对同一片段输出短→长多个候选，要让最长者胜出）
    const sortedEntities = [...entities].sort(
      (a, b) => b.start - a.start || b.end - a.end
    );

    // 收集已采用的区间，跳过重叠（自定义 detector 可能返回重叠区间，
    // 直接替换会导致后替换改写前替换已写入的占位符，产生错乱）。
    const chosen: Array<[number, number]> = [];
    const overlapsChosen = (s: number, e: number) =>
      chosen.some(([cs, ce]) => s < ce && e > cs);

    for (const entity of sortedEntities) {
      const s = entity.start;
      const e = entity.end;
      if (overlapsChosen(s, e)) continue;
      chosen.push([s, e]);

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

      // 避免重复添加同一映射条目
      if (!seenPlaceholders.has(entry.placeholder)) {
        seenPlaceholders.add(entry.placeholder);
        mappings.push(entry);
      }
    }

    return { text: result, mappings };
  }

  /**
   * 将占位符还原为原文
   * @param text 包含占位符的文本
   * @returns 还原后的文本
   */
  restore(text: string): string {
    if (text.length === 0 || this.reverseMap.size === 0) {
      return text;
    }

    // 单趟正则替换所有占位符，避免每个占位符全文本扫描 N 次的 O(N·L) 开销。
    // 对占位符中的正则特殊字符做转义，防御未来占位符格式变化。
    const pattern = Array.from(this.reverseMap.keys())
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');

    return text.replace(
      new RegExp(pattern, 'g'),
      (ph) => this.reverseMap.get(ph) ?? ph
    );
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
   *
   * 注意：必须使用递归遍历而非 JSON 字符串替换（JSON.stringify → replace → parse）。
   * 若原文敏感值含双引号/反斜杠/换行，在 JSON 字符串层做正则替换会破坏结构导致
   * JSON.parse 失败或还原错位。
   */
  restoreObject(obj: Record<string, unknown>): Record<string, unknown> {
    return this.traverseAndRestore(obj);
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
   * 获取待同步的新映射队列
   */
  getPendingSync(): MappingEntry[] {
    return [...this.pendingSync];
  }

  /**
   * 标记指定占位符的映射已同步，从待同步队列中移除
   */
  markAsSynced(placeholder: string): void {
    this.pendingSync = this.pendingSync.filter(
      (entry) => entry.placeholder !== placeholder
    );
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
    this.pendingSync = this.pendingSync.filter(
      (entry) => entry.caseId !== caseId
    );
  }

  /**
   * 清除所有映射
   */
  clearAllMappings(): void {
    this.mappings.clear();
    this.reverseMap.clear();
    this.pendingSync = [];
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
    // 防碰撞：极低概率下生成重复占位符时重新生成
    let placeholder = generateTypedPlaceholder(type);
    while (this.reverseMap.has(placeholder)) {
      placeholder = generateTypedPlaceholder(type);
    }
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
    this.pendingSync.push(entry);

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

  /**
   * 递归遍历并还原对象（与 traverseAndDesensitize 对称）
   */
  private traverseAndRestore(obj: unknown): any {
    if (typeof obj === 'string') {
      return this.restore(obj);
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.traverseAndRestore(item));
    }

    if (obj !== null && typeof obj === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        result[key] = this.traverseAndRestore(value);
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