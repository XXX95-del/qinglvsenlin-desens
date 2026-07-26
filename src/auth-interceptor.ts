/**
 * 全局 fetch 拦截器
 *
 * 在浏览器端自动拦截 fetch 请求，
 * 对 POST/PUT/PATCH 请求体自动脱敏，
 * 对 GET 响应体自动还原占位符。
 *
 * 使用前需先初始化引擎并注册。
 */

import { DesensitizeEngine, type DesensitizeOptions } from './desensitize-engine';

// ============================================================
// 默认配置
// ============================================================

/** 拦截器配置 */
export interface InterceptorConfig {
  /** API 基础路径（默认 '/api'） */
  apiBasePath?: string;
  /** 排除脱敏的路径前缀 */
  excludePaths?: string[];
  /** 脱敏选项 */
  desensitizeOptions: DesensitizeOptions;
}

// ============================================================
// 拦截器
// ============================================================

/**
 * 全局 fetch 拦截器
 * 注册后自动拦截所有 fetch 请求并执行脱敏/还原
 */
export class AuthInterceptor {
  private engine: DesensitizeEngine;
  private config: InterceptorConfig;
  private originalFetch: typeof window.fetch;
  private isRegistered = false;

  constructor(engine: DesensitizeEngine, config: InterceptorConfig) {
    this.engine = engine;
    this.config = {
      apiBasePath: '/api',
      excludePaths: ['/api/auth', '/api/health'],
      ...config,
    };
    this.originalFetch = window.fetch.bind(window);
  }

  /**
   * 注册拦截器（替换全局 fetch）
   */
  register(): void {
    if (this.isRegistered) return;

    const self = this;
    const originalFetch = this.originalFetch;

    window.fetch = async function (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method || 'GET').toUpperCase();

      // 检查是否在排除路径中
      if (self.shouldSkip(url)) {
        return originalFetch(input, init);
      }

      // 对 POST/PUT/PATCH 请求体脱敏
      if (['POST', 'PUT', 'PATCH'].includes(method) && init?.body) {
        try {
          const bodyObj = JSON.parse(init.body as string);
          const desensitized = self.engine.desensitizeObject(
            bodyObj,
            self.config.desensitizeOptions
          );
          init = {
            ...init,
            body: JSON.stringify(desensitized),
            headers: {
              ...init.headers,
              'Content-Type': 'application/json',
            },
          };
        } catch {
          // 非 JSON 请求体或脱敏失败，跳过脱敏，原样发送
        }
      }

      const response = await originalFetch(input, init);

      // 对 GET 响应体还原
      if (method === 'GET' && response.ok) {
        const clonedResponse = response.clone();
        const contentType = clonedResponse.headers.get('content-type') || '';

        if (contentType.includes('application/json')) {
          try {
            const data = await clonedResponse.json();
            const restored = self.engine.restoreObject(data);
            return new Response(JSON.stringify(restored), {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            });
          } catch {
            // 解析失败，返回原始响应
          }
        }
      }

      return response;
    };

    this.isRegistered = true;
  }

  /**
   * 注销拦截器（恢复原始 fetch）
   */
  unregister(): void {
    if (!this.isRegistered) return;
    window.fetch = this.originalFetch;
    this.isRegistered = false;
  }

  /**
   * 检查是否应该跳过脱敏
   */
  private shouldSkip(url: string): boolean {
    const path = new URL(url, window.location.origin).pathname;
    return this.config.excludePaths!.some(exclude => path.startsWith(exclude));
  }
}