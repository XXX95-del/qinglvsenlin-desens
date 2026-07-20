# 青律森林 · 脱敏系统

> 基于客户端零信任架构的数据脱敏系统  
> 在浏览器端完成敏感数据识别、脱敏与还原，服务器端无法解密原始数据

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

---

## 概述

本系统实现了一种**客户端零信任**的数据脱敏方案：

- 敏感数据在**浏览器端**被识别并替换为纯随机占位符
- 映射表使用 **AES-256-GCM** 加密后存储，密钥通过 **PBKDF2** 派生
- 服务器端仅存储加密密文和脱敏后的占位符，**无法还原原始数据**
- 全局 `fetch` 拦截器自动完成请求脱敏与响应还原，**用户无感**
- 支持**跨案件隔离**，同一原文在不同案件中映射到不同占位符

---

## 架构

```
┌──────────────────────────────────────────────┐
│                  客户端（浏览器）               │
│                                                │
│  AuthInterceptor（全局 fetch 拦截器）          │
│  POST/PUT/PATCH → 自动脱敏                    │
│  GET → 自动还原                               │
│                                                │
│  ┌─────────────┐  ┌──────────┐  ┌──────────┐  │
│  │ 脱敏引擎     │  │ 加密模块 │  │ 元数据   │  │
│  │ 敏感信息识别 │  │ AES-256- │  │ 实体角色 │  │
│  │ 纯随机占位符 │  │ GCM      │  │ 关系抽取 │  │
│  │ 跨案件隔离   │  │ PBKDF2   │  │ 语义标签 │  │
│  └─────────────┘  └──────────┘  └──────────┘  │
│                                                │
│  密钥管理：会话密钥（内存）│ 设备密钥（IndexedDB）│
│              登出即销毁    │  non-extractable   │
└──────────────────────┬───────────────────────┘
                       │ HTTPS（仅传输加密数据）
                       ▼
┌──────────────────────────────────────────────┐
│                  服务器端                     │
│          存储 AES-256-GCM 加密密文            │
│           存储纯随机占位符                     │
│           存储结构化元数据（供 AI 使用）       │
│              不存在解密密钥                    │
│            无法还原原始数据                     │
└──────────────────────────────────────────────┘
```

---

## 核心模块

### 脱敏引擎 (`desensitize-engine.ts`)

核心引擎，管理敏感信息的识别、占位符生成、映射维护和脱敏/还原操作。

**关键特性：**
- 插件式识别器接口，支持自定义敏感信息检测规则
- 纯随机占位符生成（`crypto.getRandomValues()`，8 位十六进制）
- 跨案件隔离：`MappingKey = caseId + '::' + originalText`
- 案件内一致性：同一案件内同一原文映射到同一占位符
- 导入/导出映射表（用于云端同步）

```typescript
import { DesensitizeEngine } from './desensitize-engine';

const engine = new DesensitizeEngine();

// 自定义识别器
engine.registerDetector({
  name: 'phone',
  detect(text: string) {
    const regex = /1[3-9]\d{9}/g;
    const matches: DetectorMatch[] = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
      matches.push({
        original: match[0],
        start: match.index,
        end: match.index + match[0].length,
        type: 'MOB',
        metadata: { entityType: 'phone' },
      });
    }
    return matches;
  },
});

// 脱敏
const result = await engine.desensitize('请联系张三，电话13800138000', 'case-001');
console.log(result.text); // "请联系 a8f3d9e2，电话 b7c2e1f4"

// 还原
const restored = await engine.restore(result.text, 'case-001');
console.log(restored); // "请联系张三，电话13800138000"
```

### 随机占位符 (`random-placeholder.ts`)

使用 `crypto.getRandomValues()` 生成 8 位十六进制随机占位符。

```typescript
import { generatePlaceholder } from './random-placeholder';

const placeholder = generatePlaceholder(); // 例如 "a8f3d9e2"
```

### 加密模块 (`mapping-crypto.ts`)

AES-256-GCM 认证加密 + PBKDF2 密钥派生。

```typescript
import { deriveKeyFromPassword, encrypt, decrypt, setSessionKey, clearSessionKey } from './mapping-crypto';

// 从密码派生密钥
const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await deriveKeyFromPassword('user-password', salt);

// 加密
const encrypted = await encrypt('敏感数据', key);

// 解密
const decrypted = await decrypt(encrypted, key);

// 会话密钥管理
setSessionKey(key);
// ... 使用会话密钥 ...
clearSessionKey(); // 登出时销毁
```

### 元数据系统 (`mapping-metadata.ts`)

为脱敏后的数据提供结构化语义信息，供 AI 在不接触原文的情况下完成推理分析。

```typescript
import { buildMetadata, LEGAL_ROLES, RELATION_TYPES } from './mapping-metadata';

const metadata = buildMetadata('张三', 'PER', '原告张三诉被告李四合同纠纷');
console.log(metadata.role); // "plaintiff"
```

### 云端同步 (`mapping-sync.ts`)

加密映射表的上传与拉取，支持多设备登录。

```typescript
import { onLogin, onMappingChange, onLogout } from './mapping-sync';

// 登录时：派生密钥 + 拉取云端映射 + 解密入缓存
await onLogin('user-password');

// 映射变更时：加密 + 上传云端
await onMappingChange({ caseId: 'case-001', mappings: [...] });

// 登出时：清除密钥和缓存
onLogout();
```

### 全局拦截器 (`auth-interceptor.ts`)

自动拦截全局 `fetch` 请求，对请求体脱敏、响应体还原。

```typescript
import { AuthInterceptor } from './auth-interceptor';

const interceptor = new AuthInterceptor({
  engine: desensitizeEngine,
  excludePaths: ['/api/auth/', '/api/workshop/'],
  skipFields: ['status', 'type', 'id', 'user_id'],
});

interceptor.install(); // 开始拦截
// ... 所有 fetch 请求自动脱敏/还原 ...
interceptor.uninstall(); // 停止拦截
```

---

## 安全设计

### 两级密钥体系

| 密钥类型 | 生成方式 | 存储位置 | 用途 |
|---------|---------|---------|------|
| 设备密钥 | `crypto.subtle.generateKey()` | IndexedDB（non-extractable） | 本地数据加密 |
| 会话密钥 | PBKDF2(password, salt, 100000 次迭代) | 会话内存（闭包变量） | 云端同步解密 |

### 安全防护措施

- **AES-256-GCM 认证加密**：提供机密性和完整性保护，防篡改
- **PBKDF2 100,000 次迭代**：增加暴力破解成本
- **随机盐值**：每次登录使用不同盐值，防预计算攻击
- **跨案件隔离**：同一原文在不同案件映射到不同占位符，防跨案件关联
- **密钥不可导出**：设备密钥设置为 `non-extractable`，无法通过 JS API 导出
- **登出即销毁**：会话密钥仅存于内存，登出后立即置空

### 自动清理机制

- 结案 90 天 → 归档
- 归档 180 天 → 清理
- 云端备份保留，用户访问时自动恢复

---

## 快速开始

```bash
# 安装依赖
pnpm install

# 类型检查
pnpm typecheck
```

### 基本使用

```typescript
import { DesensitizeEngine, generatePlaceholder, buildMetadata } from './src/index';

const engine = new DesensitizeEngine();

// 1. 注册自定义识别器
engine.registerDetector({
  name: 'custom',
  detect(text) {
    // 实现自定义敏感信息识别规则
    return [];
  },
});

// 2. 脱敏
const result = await engine.desensitize('原始文本', 'case-001');
console.log('脱敏后:', result.text);
console.log('映射表:', result.mappings);

// 3. 还原
const restored = await engine.restore(result.text, 'case-001');
console.log('还原后:', restored);
```

---

## 环境变量

| 变量 | 说明 | 示例 |
|------|------|------|
| `SUPABASE_URL` | Supabase 项目 URL | `https://xxx.supabase.co` |
| `SUPABASE_ANON_KEY` | Supabase 匿名密钥 | `eyJxxx...` |

---

## 技术栈

| 技术 | 用途 |
|------|------|
| Web Crypto API | AES-256-GCM 加密 / PBKDF2 密钥派生 |
| IndexedDB | 加密映射表本地存储 |
| Supabase | 加密映射表云端同步 |
| TypeScript | 类型安全 |

---

## 许可证

[Apache License 2.0](LICENSE)

---

## 关于

本系统是 [青律森林](https://qinglvsenlin.cn) 法律服务实践管理平台的核心安全组件。

> 青律森林 — 一个帮助律师成长的网站
> 我不是工具，我是你身边的一个陪伴者——帮你理清思路、支持判断、也敢于接受你的质疑。